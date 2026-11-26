#!/usr/bin/env python3
"""Replay failed OSM tools over host-network HTTPS and fill the existing Relay cache.

No model or Hub credentials are used. Only successful complete Overpass JSON is
cached; the original MCP produces query bytes. Execute explicitly from a terminal.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import time


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare_request(method, url, kwargs):
    import urllib.parse
    import httpx
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == 'http':
        url = urllib.parse.urlunsplit(('https', parsed.netloc, parsed.path, parsed.query, ''))
    if kwargs.get('params'):
        url += ('&' if urllib.parse.urlsplit(url).query else '?') + urllib.parse.urlencode(kwargs['params'], doseq=True)
    headers = dict(kwargs.get('headers') or {})
    body = kwargs.get('data')
    if isinstance(body, dict):
        body = urllib.parse.urlencode(body, doseq=True).encode()
        headers.setdefault('Content-Type', 'application/x-www-form-urlencoded')
    elif isinstance(body, str):
        body = body.encode()
    return method, str(httpx.URL(url)), body, headers


def worker(args):
    import httpx
    sys.path.insert(0, '/agent-environment/src/agent_environment')
    import osm_mcp_compat as osm
    cache_module = load('direct_overpass_cache', '/relay-code/overpass_cache.py')
    cache = cache_module.OverpassCache(args.cache)

    class DirectRequest:
        def __init__(self, method, url, kwargs):
            self.request = prepare_request(method, url, kwargs)

        async def __aenter__(self):
            method, url, body, headers = self.request
            identity = cache.identity(url, method, body, headers, True)
            if identity:
                cached = await asyncio.to_thread(cache.read, identity[0])
                if cached is not None:
                    print(json.dumps({'direct_cache': 'hit', 'host': httpx.URL(url).host}), file=sys.stderr, flush=True)
                    return osm._RelayResponse(osm_relay_response(cached))
            started = time.monotonic()
            print(json.dumps({"direct_cache": "requesting", "host": httpx.URL(url).host,
                              "local_timeout": None}), file=sys.stderr, flush=True)
            # No local request deadline. Bypass ambient HTTP(S)_PROXY settings.
            try:
                async with httpx.AsyncClient(timeout=None, trust_env=False, follow_redirects=True) as client:
                    response = await client.request(method, url, content=body, headers=headers)
            except httpx.TransportError as exc:
                raise osm.RelayNetworkError('Direct HTTPS failed: ' + type(exc).__name__) from None
            # HTTPX decoded the bytes; never save Content-Encoding for decoded content.
            result = (response.status_code,
                      {'Content-Type': response.headers.get('content-type', 'application/json')},
                      response.content, str(response.url), 1, 0.0)
            valid = identity is not None and cache.successful(result)
            if identity is not None and response.status_code == 200 and not valid:
                raise osm.RelayNetworkError('Direct Overpass returned incomplete, invalid or oversized cache JSON')
            if valid:
                await asyncio.to_thread(cache.save, identity[0], identity[1], result)
            print(json.dumps({'direct_cache': 'saved' if valid else 'not_saved',
                             'host': httpx.URL(url).host, 'status': response.status_code,
                             'seconds': round(time.monotonic()-started, 2)}), file=sys.stderr, flush=True)
            return osm._RelayResponse(osm_relay_response(result))

        async def __aexit__(self, *_):
            return False

    def osm_relay_response(result):
        from egress_relay_client import RelayResponse
        return RelayResponse(result[0], result[1], result[2], result[3])

    class DirectFallback:
        def __init__(self, session, request, urls, positional, kwargs):
            self.urls, self.kwargs, self.active = urls, kwargs, None

        async def __aenter__(self):
            last = None
            for index, url in enumerate(self.urls):
                kwargs = {**self.kwargs,
                          'headers': {**osm.OVERPASS_HEADERS, **dict(self.kwargs.get('headers') or {})}}
                context = DirectRequest('POST', url, kwargs)
                try:
                    response = await context.__aenter__()
                except osm.RelayNetworkError as exc:
                    last = exc
                    continue
                if response.status in osm.RETRYABLE_STATUSES and index + 1 < len(self.urls):
                    continue
                self.active = context
                return response
            raise last or RuntimeError('No Overpass node responded')

        async def __aexit__(self, *args):
            if self.active:
                return await self.active.__aexit__(*args)
            return False

    osm._FallbackRequestContext = DirectFallback
    osm._relay_request = lambda method, url, kwargs: DirectRequest(method, url, kwargs)
    osm.install_overpass_redirect()
    osm.install_route_fallback()
    osm.install_neighborhood_optimization()
    osm.install_explore_area_optimization()
    # Intentionally omit install_tool_deadlines only in this offline cache filler.
    osm.server.mcp.run()


async def execute(args):
    from datetime import timedelta
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    helper = load('osm_prewarm_progress', Path(__file__).with_name('prewarm_osm_cache.py'))
    requests = helper.collect([args.input])
    state = args.state or args.input.with_suffix('.direct.progress.json')
    cache = args.cache.resolve()
    if not cache.exists():
        raise SystemExit('Existing Relay cache database not found; do not create an unrelated cache.')
    script = Path(__file__).resolve()
    root = script.parents[1]
    command = ['run', '--rm', '-i', '--network', 'host', '--user', '0:0',
               '--volume', f'{script}:/warm.py:ro',
               '--volume', f'{root / "relay"}:/relay-code:ro',
               '--volume', f'{cache.parent}:/osm-cache:rw',
               '--entrypoint', 'uv', args.image,
               'run', '--python', '3.13', '--no-project', '--with', 'mcp==1.28.1',
               '--with', 'osm-mcp-server==0.1.1', 'python', '/warm.py', '--worker',
               '--cache', '/osm-cache/' + cache.name]
    # Normal MCP clients have a finite read timeout. This offline tool uses a
    # practical non-expiring horizon; Ctrl+C still tears down its stdio/container.
    with helper.Progress(state, 'direct://local-overpass-cache', str(cache)).locked() as progress:
        selected = progress.selected(requests)[:args.limit]
        print(json.dumps({'selected': len(selected), 'cache': str(cache), 'state': str(state),
                          'mode': 'direct HTTPS; no local HTTP deadline; Ctrl+C cancels'}), flush=True)
        if not selected:
            return
        progress.run_state('running')
        try:
            async with stdio_client(StdioServerParameters(command='docker', args=command)) as streams:
                async with ClientSession(streams[0], streams[1]) as client:
                    await client.initialize()
                    for index, item in selected:
                        progress.record(item, 'running')
                        started = time.monotonic()
                        try:
                            result = await client.call_tool(item['tool'], item['arguments'],
                                read_timeout_seconds=timedelta(days=36500))
                        except asyncio.CancelledError:
                            progress.record(item, 'interrupted')
                            raise
                        text = '\n'.join(getattr(part, 'text', '') for part in result.content)
                        status = 'error' if result.isError else 'success'
                        progress.record(item, status, text if result.isError else None)
                        print(json.dumps({'index': index, 'tool': item['tool'], 'status': status,
                                          'seconds': round(time.monotonic()-started, 2),
                                          **({'error': text[:500]} if result.isError else {})}), flush=True)
                        await asyncio.sleep(args.interval)
            progress.run_state('pass_finished')
        except (asyncio.CancelledError, KeyboardInterrupt):
            progress.run_state('interrupted')
            raise
        except BaseException:
            progress.run_state('transport_error')
            raise


def main():
    # The worker is bind-mounted as /warm.py, which has only one parent.
    script = Path(__file__).resolve()
    root = script.parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', nargs='?', type=Path)
    parser.add_argument('--cache', type=Path,
        default=root/'data/v2-container/runtime/relay/overpass-cache.sqlite3')
    parser.add_argument('--state', type=Path)
    parser.add_argument('--image', default='mcp-atlas-runtime:latest')
    parser.add_argument('--limit', type=int, default=200)
    parser.add_argument('--interval', type=float, default=5)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        worker(args)
    else:
        if args.input is None or args.limit < 1 or args.interval < 0:
            parser.error('input required; positive limit and nonnegative interval')
        asyncio.run(execute(args))


if __name__ == '__main__':
    main()
