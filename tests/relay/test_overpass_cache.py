import importlib.util
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("overpass_cache", Path(__file__).resolve().parents[2] / "relay/overpass_cache.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
URL = "https://overpass-api.de/api/interpreter"
MIRROR = "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
HEADERS = {"content-type": "application/x-www-form-urlencoded"}
BODY = b'data=[out:json];node(1);out;'


def result(body=b'{"elements":[{"id":1}]}', status=200):
    return status, {"content-type": "application/json"}, body, URL, 1, 0.0


def request(cache, send, *, url=URL, body=BODY, headers=HEADERS, check=lambda: None):
    return cache.fetch(url, "POST", body, headers, False, send, check)


def test_persistent_hit_preserves_raw_body_across_mirrors_and_restart(tmp_path):
    cache = module.OverpassCache(tmp_path / "cache.db")
    raw = b'{ "elements": [], "osm3s": {"timestamp_osm_base":"2026-11-16"} }'
    first, status = request(cache, lambda: result(raw))
    assert status == "miss"
    cache = module.OverpassCache(tmp_path / "cache.db")
    hit, status = request(cache, lambda: pytest.fail("network called"), url=MIRROR)
    assert status == "hit" and hit[:4] == first[:4] and hit[4] == 0
    assert hit[2] == raw


@pytest.mark.parametrize("response", [result(status=429), result(status=502), result(b'not JSON'), result(b'{"elements":[],"remark":"runtime error: timeout"}'), result(b'{"error":"failed"}')])
def test_failed_and_partial_responses_are_never_cached(tmp_path, response):
    cache = module.OverpassCache(tmp_path / "cache.db")
    assert request(cache, lambda: response)[1] == "miss"
    assert request(cache, lambda: result())[1] == "miss"


def test_exact_parameters_and_authenticated_requests_do_not_share(tmp_path):
    cache = module.OverpassCache(tmp_path / "cache.db")
    request(cache, result)
    assert request(cache, result, body=BODY+b" ")[1] == "miss"
    assert request(cache, result, headers={"Authorization": "Bearer private"})[1] == "bypass"
    assert request(cache, result, url=URL+"/status")[1] == "bypass"


def test_concurrent_misses_share_one_network_call(tmp_path):
    cache = module.OverpassCache(tmp_path / "cache.db")
    entered, release = threading.Event(), threading.Event()
    calls = []
    def send():
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return result()
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(request, cache, send) for _ in range(8)]
        assert entered.wait(5)
        release.set()
        rows = [future.result() for future in futures]
    assert len(calls) == 1
    assert [row[1] for row in rows].count("hit") == 7
    assert not cache.locks


def test_expiry_and_weekly_refresh_preserve_old_success_on_failure(tmp_path):
    clock = [0]
    cache = module.OverpassCache(tmp_path / "cache.db", ttl=30*86400, refresh=7*86400, clock=lambda: clock[0])
    request(cache, result)
    clock[0] = 8*86400
    sent = []
    def failed(request):
        sent.append(request)
        raise TimeoutError()
    cache.refresh_due(failed, pause=0)
    cache.refresh_due(failed, pause=0)
    assert len(sent) == 1
    assert request(cache, lambda: pytest.fail("old success lost"))[1] == "hit"
    clock[0] = 9*86400
    raw = b'{"elements":[{"id":2}]}'
    cache.refresh_due(lambda request: result(raw), pause=0)
    assert request(cache, result)[0][2] == raw
    clock[0] = 40*86400
    assert request(cache, result)[1] == "miss"


def test_storage_failure_bypasses_and_waiter_deadline_does_not_cancel_leader(tmp_path):
    path = tmp_path / "not-a-directory"
    path.write_text('file')
    cache = module.OverpassCache(path / "cache.db")
    assert request(cache, result)[0][0] == 200
    cache = module.OverpassCache(tmp_path / "cache.db")
    entered, release = threading.Event(), threading.Event()
    def send():
        entered.set()
        assert release.wait(5)
        return result()
    with ThreadPoolExecutor(max_workers=2) as pool:
        leader = pool.submit(request, cache, send)
        assert entered.wait(5)
        def cancelled():
            raise TimeoutError("client cancelled")
        with pytest.raises(TimeoutError):
            request(cache, result, check=cancelled)
        release.set()
        assert leader.result()[0][0] == 200
    assert request(cache, result)[1] == "hit"


def test_background_refresh_does_not_block_valid_readers_or_keep_unused_entries_alive(tmp_path):
    clock = [0]
    cache = module.OverpassCache(tmp_path / "cache.db", clock=lambda: clock[0])
    request(cache, result)
    clock[0] = 8*86400
    entered, release = threading.Event(), threading.Event()
    def send(request):
        entered.set()
        assert release.wait(5)
        return result()
    with ThreadPoolExecutor(max_workers=2) as pool:
        background = pool.submit(cache.refresh_due, send, pause=0)
        assert entered.wait(5)
        reader = pool.submit(request, cache, lambda: pytest.fail("reader sent network request"))
        try:
            assert reader.result(timeout=2)[1] == "hit"
        finally:
            release.set()
        background.result()
    clock[0] = 39*86400
    assert cache.refresh_due(lambda req: pytest.fail("unused entry refreshed"), pause=0) == 0


def test_prewarm_reads_only_actual_calls_not_reference_answers(tmp_path):
    spec = importlib.util.spec_from_file_location("prewarm", Path(__file__).resolve().parents[2]/"scripts/prewarm_osm_cache.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    p = tmp_path / "history.json"
    p.write_text(json.dumps({"raw_conversation_history": [{"role":"assistant", "tool_calls":[{"function":{"name":"osm-mcp-server_find_nearby_places", "arguments":"{\"radius\":100}"}}]}], "TRAJECTORY":"reference", "GTFA_CLAIMS":"reference"}))
    assert script.collect([p]) == [{"tool":"find_nearby_places", "arguments":{"radius":100}}]


def load_prewarm():
    spec = importlib.util.spec_from_file_location("prewarm", Path(__file__).resolve().parents[2]/"scripts/prewarm_osm_cache.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    return script


def test_progress_resumes_only_failures_and_never_repeats_success(tmp_path):
    m = load_prewarm()
    requests = [{"tool":"find_nearby_places", "arguments":{"radius":n}} for n in range(4)]
    path = tmp_path/'progress.json'
    with m.Progress(path, 'http://hub/mcp/osm', 'official').locked() as p:
        p.record(requests[0], 'running'); p.record(requests[0], 'success')
        p.record(requests[1], 'running'); p.record(requests[1], 'error')
        p.record(requests[2], 'running')
    with m.Progress(path, 'http://hub/mcp/osm', 'official').locked() as p:
        assert [i for i,_ in p.selected(requests)] == [4,2,3]
        assert [i for i,_ in p.selected(requests, True)] == [2,3]
        with pytest.raises(SystemExit, match='Another prewarm'):
            with m.Progress(path, 'http://hub/mcp/osm', 'official').locked():
                pass
    with pytest.raises(SystemExit, match='different endpoint/account'):
        with m.Progress(path, 'http://hub/mcp/osm', 'account-b').locked():
            pass


@pytest.mark.parametrize('message,stops_after', [
    ('All query workers are busy; request queue is full',1),
    ('Relay upstream deadline exceeded',3),
    ('HTTP 429 Too Many Requests',1),
])
def test_prewarm_waits_on_overload_and_continues_one_probe_at_a_time(tmp_path, message, stops_after):
    import asyncio
    from types import SimpleNamespace
    m = load_prewarm()
    requests = [{'tool':'find_nearby_places','arguments':{'radius':n}} for n in range(5)]
    count = []
    pauses = []
    class Client:
        async def call_tool(self, *args, **kwargs):
            count.append(1)
            return SimpleNamespace(isError=True, content=[SimpleNamespace(text=message+' api_key=secret-value')])
    with m.Progress(tmp_path/'p.json', 'http://hub/mcp/osm', 'official').locked() as p:
        original_state = p.run_state
        def state(status, **fields):
            if status == 'waiting_upstream':
                pauses.append(len(count))
            original_state(status, **fields)
        p.run_state = state
        selected = p.selected(requests)
        recovering = False
        while True:
            healthy = asyncio.run(m.run_requests(Client(), {'find_nearby_places':'nearby'}, SimpleNamespace(interval=0, pause_seconds=0), selected, p, 'hub-token', recovering=recovering))
            if not isinstance(healthy, dict):
                break
            selected = healthy['remaining']
            recovering = True
        assert healthy is True and len(count) == 5
        assert pauses[0] == stops_after
        assert len(p.selected(requests, True)) == 5
        assert 'secret-value' not in json.dumps(p.data)
        assert all(v['attempts'] == 1 for v in p.data['requests'].values())


def test_prewarm_interrupts_and_transport_failure_never_mark_remaining_as_failed(tmp_path):
    import asyncio
    from types import SimpleNamespace
    m = load_prewarm()
    requests = [{'tool':'find_nearby_places','arguments':{'radius':n}} for n in range(3)]
    class Cancelled:
        async def call_tool(self, *args, **kwargs):
            raise asyncio.CancelledError()
    class Disconnected:
        async def call_tool(self, *args, **kwargs):
            raise ConnectionError('Authorization: Bearer actual-private-token')
    path = tmp_path/'p.json'
    with m.Progress(path, 'http://hub/mcp/osm', 'official').locked() as p:
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(m.run_requests(Cancelled(), {'find_nearby_places':'nearby'}, SimpleNamespace(interval=0), p.selected(requests), p, 'hub-token'))
        assert len(p.selected(requests, True)) == 1
        assert asyncio.run(m.run_requests(Disconnected(), {'find_nearby_places':'nearby'}, SimpleNamespace(interval=0), p.selected(requests), p, 'hub-token')) is False
        assert len(p.data['requests']) == 2
        assert 'actual-private-token' not in json.dumps(p.data)


def test_prewarm_closes_session_before_cooldown_then_reconnects(monkeypatch, tmp_path):
    import asyncio
    import sys
    from types import SimpleNamespace
    m = load_prewarm()
    events = []
    class Transport:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self):
            events.append('connect')
            return (None,None)
        async def __aexit__(self, *args):
            events.append('disconnect')
    class Session:
        def __init__(self, *args): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def initialize(self): pass
        async def list_tools(self):
            return SimpleNamespace(tools=[SimpleNamespace(name='osm-find_nearby_places')])
        async def call_tool(self, *args, **kwargs):
            events.append('call')
            return SimpleNamespace(isError=True,content=[SimpleNamespace(text='All query workers are busy')])
    async def sleep(seconds):
        if seconds:
            events.append('sleep')
            assert events[-2] == 'disconnect'
    monkeypatch.setenv('MCPHUB_TOKEN', 'private')
    monkeypatch.setitem(sys.modules,'mcp',SimpleNamespace(ClientSession=Session))
    monkeypatch.setitem(sys.modules,'mcp.client',SimpleNamespace())
    monkeypatch.setitem(sys.modules,'mcp.client.streamable_http',SimpleNamespace(streamablehttp_client=Transport))
    monkeypatch.setattr(m.asyncio,'sleep',sleep)
    args=SimpleNamespace(url='http://hub/mcp/osm',target='official',retry_errors=False,limit=5,interval=0,pause_seconds=1)
    requests=[{'tool':'find_nearby_places','arguments':{'radius':n}} for n in range(2)]
    with m.Progress(tmp_path/'p.json',args.url,args.target).locked() as p:
        assert asyncio.run(m.execute(args,requests,p)) is True
    assert events == ['connect','call','disconnect','sleep','connect','call','disconnect']


def test_prewarm_tool_call_reserves_full_osm_timeout(tmp_path):
    import asyncio
    from types import SimpleNamespace
    m = load_prewarm()
    seen = []
    class Client:
        async def call_tool(self, *args, **kwargs):
            seen.append(kwargs['read_timeout_seconds'].total_seconds())
            return SimpleNamespace(isError=False, content=[])
    requests = [{'tool': 'find_nearby_places', 'arguments': {'radius': 100}}]
    with m.Progress(tmp_path/'p.json', 'http://hub/mcp/osm', 'official').locked() as p:
        assert asyncio.run(m.run_requests(Client(), {'find_nearby_places': 'nearby'},
            SimpleNamespace(interval=0, timeout=420), p.selected(requests), p, 'hub-token'))
    assert seen == [420]
