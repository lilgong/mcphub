#!/usr/bin/env python3
"""Collect real Overpass-producing tool calls; optionally replay through MCPHub.

Never read reference TRAJECTORY/claims or generate answers. Requires the Python MCP
SDK only with --execute. Model-facing responses are not changed by this script.
"""
import argparse
import asyncio
import csv
import contextlib
import fcntl
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path

TOOLS = {"find_nearby_places", "find_parking_facilities", "find_ev_charging_stations",
         "explore_area", "analyze_neighborhood", "search_category"}
ERROR_STATES = {"error", "transport_error", "tool_unavailable", "interrupted"}


def request_id(item):
    return hashlib.sha256(json.dumps(item, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class Progress:
    def __init__(self, path, url, target):
        self.path = Path(path)
        self.scope = {"url": url.rstrip('/'), "target": target}
        self.data = {"schema_version": 1, "kind": "osm-cache-prewarm-progress", "scope": self.scope, "requests": {}}

    @contextlib.contextmanager
    def locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.with_suffix(self.path.suffix+'.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SystemExit('Another prewarm process owns this progress file; stop it first.') from None
            if self.path.exists():
                self.data = json.loads(self.path.read_text())
                if self.data.get('schema_version') != 1 or self.data.get('scope') != self.scope:
                    raise SystemExit('Progress belongs to a different endpoint/account; select a different --state file.')
            # A crash or Ctrl+C can leave the last request unfinished.
            for entry in self.data['requests'].values():
                if entry.get('status') == 'running':
                    entry['status'] = 'interrupted'
            self.save()
            try:
                yield self
            finally:
                self.save()

    def save(self):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=self.path.parent, delete=False) as handle:
                temporary = Path(handle.name)
                json.dump(self.data, handle, ensure_ascii=False, indent=2)
                handle.write('\n')
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)

    def selected(self, requests, errors_only=False):
        rows = []
        for index, item in enumerate(requests, 1):
            entry = self.data['requests'].get(request_id(item), {})
            status = entry.get('status')
            if status == 'success' or (errors_only and status not in ERROR_STATES):
                continue
            rows.append((index, item))
        # Prioritize untouched work; one bad early query must not starve the
        # rest of a campaign every time the command resumes.
        return sorted(rows, key=lambda row: (
            request_id(row[1]) in self.data['requests'],
            self.data['requests'].get(request_id(row[1]), {}).get('attempts', 0),
            row[0],
        ))

    def run_state(self, status, **fields):
        self.data['run'] = {"status": status, "updated_at": time.time(), **fields}
        self.save()

    def record(self, item, status, detail=None):
        key = request_id(item)
        previous = self.data['requests'].get(key, {})
        self.data['requests'][key] = {"tool": item['tool'], "status": status,
            "attempts": previous.get('attempts', 0)+(status == 'running'),
            "updated_at": time.time(), **({"error": detail[:2000]} if detail else {})}
        self.save()


def calls(path):
    if path.suffix == ".csv":
        csv.field_size_limit(256 * 1024 * 1024)
        with path.open() as handle:
            for row in csv.DictReader(handle):
                for call in json.loads(row.get("trajectory") or "[]"):
                    yield call.get("tool_name", ""), call.get("parameters")
    else:
        data = json.loads(path.read_text())
        if data.get("schema_version") == 1 and data.get("kind") == "osm-cache-prewarm":
            for call in data["requests"]:
                yield call["tool"], call["arguments"]
            return
        data = data.get("payload", {}).get("payload", data)
        for row in data.get("raw_conversation_history", []):
            message = row.get("original_message", row)
            if message.get("role") != "assistant":
                continue
            for call in message.get("tool_calls") or []:
                function = call.get("function", {})
                arguments = function.get("arguments", "{}")
                try:
                    yield function.get("name", ""), json.loads(arguments) if isinstance(arguments, str) else arguments
                except ValueError:
                    continue


def collect(inputs):
    unique = {}
    for root in inputs:
        paths = sorted(root.rglob("*teacher.json")) if root.is_dir() else [root]
        for path in paths:
            for name, args in calls(path):
                prefix = next((p for p in ("osm-mcp-server_", "osm-mcp-server-") if name.startswith(p)), None)
                suffix = name[len(prefix):] if prefix else name
                if suffix not in TOOLS or not isinstance(args, dict):
                    continue
                key = json.dumps([suffix, args], sort_keys=True, ensure_ascii=False)
                unique[key] = {"tool": suffix, "arguments": args}
    return list(unique.values())


async def execute(args, requests, progress):
    from datetime import timedelta
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client
    selected = progress.selected(requests, args.retry_errors)[:args.limit]
    print(json.dumps({"selected": len(selected), "retry_errors": args.retry_errors, "state": str(progress.path)}), flush=True)
    if not selected:
        return True
    token = os.environ.get("MCPHUB_TOKEN")
    if not token:
        raise SystemExit("Set MCPHUB_TOKEN to a Hub group key; never use an upstream provider key.")
    headers = {"Authorization": "Bearer " + token, "X-MCPHub-Target": args.target}
    recovering = False
    while selected:
        async with streamablehttp_client(args.url, headers=headers, timeout=timedelta(seconds=getattr(args, "timeout", 420)), sse_read_timeout=timedelta(seconds=getattr(args, "timeout", 420))) as streams:
            async with ClientSession(streams[0], streams[1]) as client:
                await client.initialize()
                tools = (await client.list_tools()).tools
                names = {suffix: next((tool.name for tool in tools if tool.name.endswith("-"+suffix) or tool.name.endswith("_"+suffix)), None) for suffix in TOOLS}
                outcome = await run_requests(client, names, args, selected, progress, token, recovering=recovering)
        if not isinstance(outcome, dict):
            return outcome
        # Close the MCP session before waiting. Its event stream must not time
        # out during the pause and poison the next recovery probe.
        remaining = outcome['pause_seconds']
        while remaining > 0:
            step = min(30, remaining)
            await asyncio.sleep(step)
            remaining -= step
            print(json.dumps({"waiting_upstream": True, "remaining_seconds": remaining}), flush=True)
        progress.run_state('running')
        selected = outcome['remaining']
        recovering = True
    return True


def safe_error(message, token):
    import re
    text = message.replace(token, '[REDACTED]') if token else message
    text = re.sub(r'(?i)(bearer|basic)\s+[^\s"\',;]+', r'\1 [REDACTED]', text)
    text = re.sub(r'(?i)(api_key|token|password|secret)\s*[:=]\s*[^\s"\',;]+', r'\1=[REDACTED]', text)
    return text[:2000]


def upstream_backpressure(message):
    import re
    text = (message or '').lower()
    full = any(term in text for term in (
        'currently at capacity', 'all query workers are busy', 'request queue is full',
        'server is overloaded', 'too many requests',
    )) or bool(re.search(r'\b429\b', text))
    transient = full or any(term in text for term in (
        'timeout', 'timed out', 'deadline exceeded', 'connection reset',
        'connection refused', 'bad gateway', 'service unavailable',
    )) or bool(re.search(r'\b50[234]\b', text))
    return full, transient


async def run_requests(client, names, args, selected, progress, token, *, recovering=False):
    from datetime import timedelta
    consecutive_upstream_errors = 0
    for position, (index, item) in enumerate(selected):
        name = names[item["tool"]]
        progress.record(item, 'running')
        if name is None:
            progress.record(item, 'tool_unavailable')
            print(json.dumps({"index": index, "tool": item["tool"], "status": "tool_unavailable"}), flush=True)
            continue
        detail = None
        started = time.monotonic()
        try:
            result = await client.call_tool(name, item["arguments"], read_timeout_seconds=timedelta(seconds=getattr(args, "timeout", 420)))
            status = "error" if result.isError else "success"
            if result.isError:
                detail = safe_error('\n'.join(x.text for x in result.content if hasattr(x, 'text')), token)
        except asyncio.CancelledError:
            progress.record(item, 'interrupted')
            raise
        except Exception as exc:
            status = "transport_error"
            detail = safe_error(type(exc).__name__ + ': ' + str(exc), token)
        progress.record(item, status, detail)
        print(json.dumps({"index": index, "tool": item["tool"], "status": status,
            "seconds": round(time.monotonic()-started, 2),
            **({"error": detail[:500]} if detail else {})}), flush=True)
        if status == 'transport_error':
            # Do not turn a dead MCP session into hundreds of instant failures.
            print('Hub connection failed; progress saved. Resume after connectivity recovers.', flush=True)
            progress.run_state('transport_error')
            return False
        overloaded, transient = upstream_backpressure(detail)
        consecutive_upstream_errors = consecutive_upstream_errors+1 if status == 'error' and transient else 0
        if overloaded or consecutive_upstream_errors >= 3 or (recovering and transient):
            if position + 1 == len(selected):
                break
            pause = getattr(args, 'pause_seconds', 300)
            reason = 'upstream_capacity' if overloaded else 'consecutive_upstream_errors'
            progress.run_state('waiting_upstream', reason=reason, resume_at=time.time()+pause)
            print(json.dumps({"paused": True,
                "reason": reason, "resume_in_seconds": pause,
                "message": "Upstream unavailable; waiting before one recovery probe. Process remains running; Ctrl+C safely saves progress."}), flush=True)
            return {'pause_seconds': pause, 'remaining': selected[position+1:]}
        if status == 'success':
            recovering = False
        await asyncio.sleep(args.interval)
    return True



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--execute", action="store_true", help="Actually call tools; otherwise collect only")
    parser.add_argument("--url", default="http://192.168.0.22:3003/mcp/atlas/osm-mcp-server")
    parser.add_argument("--target", default="official")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--timeout", type=float, default=420, help="MCP call/read timeout; covers three 120-second nodes")
    parser.add_argument("--state", type=Path, help="Persistent progress; defaults beside the input file")
    parser.add_argument("--retry-errors", action="store_true", help="Retry only recorded failures/interrupted calls; skip successes AND unstarted items")
    parser.add_argument("--pause-seconds", type=float, default=300, help="Wait after upstream overload; then send one recovery probe (default 300)")
    parser.add_argument("--status", action="store_true", help="Show saved campaign progress without sending requests")
    args = parser.parse_args()
    import math
    if not math.isfinite(getattr(args, "timeout", 420)) or getattr(args, "timeout", 420) <= 0:
        parser.error("timeout must be positive and finite")
    if args.limit < 1 or not math.isfinite(args.interval) or args.interval < 0 or not math.isfinite(args.pause_seconds) or args.pause_seconds < 0:
        parser.error("limit must be positive and intervals finite/nonnegative")
    requests = collect(args.inputs)
    print(json.dumps({"unique_requests": len(requests), "execute": args.execute, "limit": args.limit}), flush=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({"schema_version": 1, "kind": "osm-cache-prewarm", "requests": requests}, ensure_ascii=False, indent=2)+"\n")
        args.output.chmod(0o600)
    if args.execute or args.status:
        state = args.state or (args.inputs[0].with_suffix('.progress.json') if args.inputs[0].is_file() else args.inputs[0]/'prewarm.progress.json')
        progress = Progress(state, args.url, args.target)
        if args.status:
            # Atomic replacements permit a read-only status check while the
            # live writer holds the campaign lock. Never modify its state.
            if state.exists():
                progress.data = json.loads(state.read_text())
                if progress.data.get('scope') != progress.scope:
                    raise SystemExit('Progress belongs to a different endpoint/account.')
            counts = {}
            for item in requests:
                status = progress.data['requests'].get(request_id(item), {}).get('status', 'pending')
                counts[status] = counts.get(status, 0)+1
            print(json.dumps({'progress': counts, 'run': progress.data.get('run'), 'state': str(state)}), flush=True)
            return
        with progress.locked():
            progress.run_state('running')
            try:
                healthy = asyncio.run(execute(args, requests, progress))
                counts = {}
                for item in requests:
                    status = progress.data['requests'].get(request_id(item), {}).get('status', 'pending')
                    counts[status] = counts.get(status, 0)+1
                print(json.dumps({'progress': counts, 'state': str(state)}), flush=True)
                if healthy is False:
                    raise SystemExit(1)
                progress.run_state('pass_finished')
            except KeyboardInterrupt:
                progress.run_state('interrupted')
                print('Prewarm stopped; completed progress was saved. Resume with the same command.', flush=True)
            except Exception as exc:
                detail = safe_error(type(exc).__name__ + ': ' + str(exc), os.environ.get('MCPHUB_TOKEN', ''))
                progress.run_state('failed', error=detail)
                print(json.dumps({'status': 'failed', 'error': detail, 'message': 'Progress saved; unstarted requests were not marked as failed.'}), flush=True)
                raise SystemExit(1) from None


if __name__ == "__main__":
    main()
