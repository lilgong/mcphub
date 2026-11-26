import gzip
import importlib.util
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import threading
import time

import pytest

spec = importlib.util.spec_from_file_location('arxiv_query_cache', Path(__file__).resolve().parents[2] / 'relay/arxiv_cache.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
URL = 'https://export.arxiv.org/api/query?search_query=all%3Aagents&start=0&max_results=1'
FEED = b'''<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
<id>https://arxiv.org/api/query</id><updated>2026-11-25T00:00:00Z</updated>
<opensearch:totalResults>2</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex>
<opensearch:itemsPerPage>1</opensearch:itemsPerPage><entry><id>http://arxiv.org/abs/2412.17451v1</id><title>Agents</title></entry></feed>'''


def result(body=FEED, status=200, headers=None):
    return status, headers or {'content-type': 'application/atom+xml'}, body, URL, 3, 4.0


def fetch(cache, send=result, *, url=URL, method='GET', body=b'', headers=None, check=lambda: None):
    return cache.fetch(url, method, body, headers or {}, False, send, check)


def test_persistent_raw_xml_hit_survives_restart(tmp_path):
    path = tmp_path / 'cache.db'
    first, state = fetch(module.ArxivQueryCache(path))
    assert state == 'miss'
    second, state = fetch(module.ArxivQueryCache(path), lambda: pytest.fail('network used'))
    assert state == 'hit' and second[:4] == first[:4] and second[4:] == (0, 0.0)
    assert second[2] == FEED


def test_ttl_is_not_extended_by_hits_and_expired_data_is_not_fallback(tmp_path):
    clock = [100.0]
    cache = module.ArxivQueryCache(tmp_path / 'cache.db', ttl=10, clock=lambda: clock[0])
    fetch(cache)
    clock[0] = 109
    assert fetch(cache)[1] == 'hit'
    clock[0] = 110
    assert fetch(cache, lambda: result(b'limited', 429))[0][0] == 429
    assert fetch(cache)[1] == 'miss'
    assert fetch(cache)[1] == 'hit'


@pytest.mark.parametrize('response', [result(status=429), result(status=504), result(status=400),
    result(b'<html>error</html>'), result(b'<feed>broken'), result(b'<feed/>'),
    result(FEED.replace(b'http://arxiv.org/abs/2412.17451v1', b'http://arxiv.org/api/errors#bad-query')),
    result(FEED.replace(b'<opensearch:totalResults>2', b'<opensearch:totalResults>-1')),
    result(FEED.replace(b'<entry>', b'<!--<entry>').replace(b'</entry>', b'</entry>-->')),
    result(FEED, headers={'content-encoding': 'br'}),
    result(b'<!DOCTYPE feed [<!ENTITY a "data">]>' + FEED)])
def test_error_partial_and_non_atom_responses_never_persist(tmp_path, response):
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    assert fetch(cache, lambda: response)[1] == 'miss'
    assert fetch(cache)[1] == 'miss'


def test_gzip_is_validated_but_stored_without_changing_bytes(tmp_path):
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    raw = gzip.compress(FEED)
    first, _ = fetch(cache, lambda: result(raw, headers={'Content-Encoding': 'gzip'}))
    hit, state = fetch(cache)
    assert state == 'hit' and hit[2] == raw and hit[1] == first[1]
    assert not cache.successful(result(raw[:-5], headers={'Content-Encoding': 'gzip'}))


@pytest.mark.parametrize('url', [URL.replace('start=0','start=1'), URL.replace('max_results=1','max_results=2'),
    URL+'&sortBy=submittedDate', URL+'&sortOrder=descending', URL.replace('agents','tools'),
    'https://export.arxiv.org/api/query?id_list=2412.17451v1', URL.replace('export.arxiv.org','arxiv.org')])
def test_different_queries_never_share(tmp_path, url):
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    fetch(cache)
    assert fetch(cache, url=url)[1] == 'miss'


@pytest.mark.parametrize('kwargs', [dict(headers={'Authorization': 'Bearer secret'}), dict(headers={'Cookie': 'private'}),
    dict(url=URL+'&api_key=secret'), dict(url='https://arxiv.org/pdf/2412.17451'),
    dict(url=URL.replace('https:', 'http:')), dict(url=URL+'#private'),
    dict(method='POST', body=b'search_query=all:agents', headers={'content-type': 'application/json'}),
    dict(body=b'non-empty-get-body')])
def test_only_public_query_requests_are_cached(tmp_path, kwargs):
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    assert fetch(cache, **kwargs)[1] == 'bypass'
    assert not cache.path.exists()


def test_form_post_is_cached_and_body_is_part_of_key(tmp_path):
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    kw = dict(url=URL.split('?')[0], method='POST', body=b'id_list=2412.17451v1', headers={'content-type': 'application/x-www-form-urlencoded'})
    assert fetch(cache, **kw)[1] == 'miss'
    assert fetch(cache, **kw)[1] == 'hit'
    assert fetch(cache, **{**kw, 'body': b'id_list=2412.17451v2'})[1] == 'miss'


@pytest.mark.parametrize('status', [200, 429])
def test_simultaneous_requests_share_one_result_including_errors(tmp_path, status):
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    entered, release, waiting = threading.Event(), threading.Event(), threading.Event()
    calls = []
    def send():
        calls.append(1); entered.set(); assert release.wait(3)
        return result(status=status)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(fetch, cache, send)
        assert entered.wait(3)
        count = [0]
        def check():
            count[0] += 1
            if count[0] > 1: waiting.set()
        second = pool.submit(fetch, cache, send, check=check)
        assert waiting.wait(3)
        release.set()
        a, b = first.result(), second.result()
    assert len(calls) == 1 and a[0][0] == b[0][0] == status
    assert b[1] == 'coalesced' and b[0][4] == 0
    assert fetch(cache)[1] == ('hit' if status == 200 else 'miss')
    assert not cache.flights


def test_waiter_deadline_does_not_cancel_shared_request(tmp_path):
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    entered, release = threading.Event(), threading.Event()
    def send():
        entered.set(); assert release.wait(3); return result()
    def expired(): raise TimeoutError('caller deadline')
    with ThreadPoolExecutor(max_workers=2) as pool:
        leader = pool.submit(fetch, cache, send)
        assert entered.wait(3)
        with pytest.raises(TimeoutError, match='caller deadline'):
            fetch(cache, send, check=expired)
        release.set(); assert leader.result()[0][0] == 200
    assert fetch(cache)[1] == 'hit'


def test_broken_storage_does_not_break_upstream(tmp_path, monkeypatch):
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    def broken(): raise sqlite3.OperationalError('locked')
    monkeypatch.setattr(cache, 'connect', broken)
    assert fetch(cache)[0][2] == FEED


def test_zero_result_feed_is_cacheable(tmp_path):
    empty = FEED.replace(b'<opensearch:totalResults>2', b'<opensearch:totalResults>0')
    empty = empty[:empty.index(b'<entry>')] + b'</feed>'
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    assert fetch(cache, lambda: result(empty))[1] == 'miss'
    assert fetch(cache)[0][2] == empty


def test_cancelled_leader_does_not_cancel_other_callers(tmp_path):
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    entered, release, waiting = threading.Event(), threading.Event(), threading.Event()
    class RelayRequestCancelled(Exception): pass
    def cancelled_send():
        entered.set(); assert release.wait(3); raise RelayRequestCancelled()
    count = [0]
    def check():
        count[0] += 1
        if count[0] > 1: waiting.set()
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(fetch, cache, cancelled_send)
        assert entered.wait(3)
        second = pool.submit(fetch, cache, result, check=check)
        assert waiting.wait(3)
        release.set()
        with pytest.raises(RelayRequestCancelled): first.result()
        assert second.result()[0][0] == 200
    assert not cache.flights and fetch(cache)[1] == 'hit'


def test_network_exception_releases_shared_waiters_without_persisting(tmp_path):
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    def failed(): raise RuntimeError('upstream failed')
    with pytest.raises(RuntimeError, match='upstream failed'): fetch(cache, failed)
    assert not cache.flights
    assert fetch(cache)[1] == 'miss'


def test_storage_prunes_expired_entries(tmp_path):
    clock = [100.0]
    cache = module.ArxivQueryCache(tmp_path / 'cache.db', ttl=10, clock=lambda: clock[0])
    fetch(cache)
    clock[0] = 111
    fetch(cache, url=URL.replace('agents','new'))
    with cache.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM responses').fetchone()[0] == 1


def test_real_arxiv_requests_client_headers_are_cacheable(tmp_path):
    import requests
    cache = module.ArxivQueryCache(tmp_path / 'cache.db')
    prepared = requests.Session().prepare_request(requests.Request('GET', URL))
    headers = dict(prepared.headers)
    headers.pop('User-Agent', None)
    assert fetch(cache, headers=headers)[1] == 'miss'
    assert fetch(cache, headers=headers)[1] == 'hit'
