import asyncio
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


def script():
    path = Path(__file__).resolve().parents[2] / 'scripts/prewarm_osm_direct.py'
    spec = importlib.util.spec_from_file_location('osm_direct', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_direct_identity_matches_relay_request_bytes():
    m = script()
    method, url, body, headers = m.prepare_request('POST', 'https://overpass-api.de/api/interpreter',
        {'data': {'data': '[out:json];node(1);out;'}, 'headers': {'Accept': 'application/json'}})
    assert method == 'POST'
    assert url == 'https://overpass-api.de/api/interpreter'
    assert body == b'data=%5Bout%3Ajson%5D%3Bnode%281%29%3Bout%3B'
    assert headers['Content-Type'] == 'application/x-www-form-urlencoded'


@pytest.mark.skipif(not Path('/agent-environment').exists(), reason='runtime image integration')
def test_direct_worker_fills_real_cache_and_does_not_cache_error(tmp_path, monkeypatch):
    import httpx
    sys.path.insert(0, '/agent-environment/src/agent_environment')
    import osm_mcp_compat as osm
    m = script()
    responses = [httpx.Response(200, json={'elements': [{'type': 'node', 'id': 1}]}),
                 httpx.Response(504, text='upstream timeout'),
                 httpx.Response(200, json={'elements': [], 'remark': 'runtime error: timeout'})]
    seen = []
    class Client:
        def __init__(self, **kwargs):
            assert kwargs['timeout'] is None and kwargs['trust_env'] is False
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
        async def request(self, method, url, **kwargs):
            seen.append((method, url, kwargs))
            r = responses.pop(0)
            r.request = httpx.Request(method, url)
            return r
    monkeypatch.setattr(httpx, 'AsyncClient', Client)
    async def run():
        def context(query):
            return osm._relay_request('POST', 'https://overpass-api.de/api/interpreter',
                {'data': {'data': query}, 'headers': osm.OVERPASS_HEADERS})
        for query, status in [('success', 200), ('success', 200), ('error', 504)]:
            async with context(query) as response:
                assert response.status == status
        with pytest.raises(osm.RelayNetworkError, match='incomplete'):
            async with context('partial'):
                pass
        assert len(seen) == 3  # second request read the shared cache
    monkeypatch.setattr(osm.server.mcp, 'run', lambda: asyncio.run(run()))
    m.worker(SimpleNamespace(cache=tmp_path/'cache.sqlite3'))
    import sqlite3
    with sqlite3.connect(tmp_path/'cache.sqlite3') as db:
        assert db.execute('SELECT COUNT(*) FROM responses').fetchone()[0] == 1


def test_worker_cli_accepts_root_mounted_script(monkeypatch):
    m = script()
    called = []
    monkeypatch.setattr(m, '__file__', '/warm.py')
    monkeypatch.setattr(m, 'worker', lambda args: called.append(args.cache))
    monkeypatch.setattr(sys, 'argv', ['/warm.py', '--worker', '--cache', '/osm-cache/cache.sqlite3'])
    m.main()
    assert called == [Path('/osm-cache/cache.sqlite3')]
