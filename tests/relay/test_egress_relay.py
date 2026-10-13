from __future__ import annotations

import importlib.util
import threading
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "pubmed_relay_server",
    ROOT / "relay" / "egress_relay.py",
)
assert SPEC and SPEC.loader
relay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(relay)


def test_ipwo_proxy_auth_failure_latches(monkeypatch):
    calls = []

    def fake_fetch(url, allow_redirects, *, session_id=None, budget=None):
        calls.append((url, allow_redirects))
        return 407, {}, b"proxy authentication required", url

    monkeypatch.setattr(relay, "_fetch_once", fake_fetch)
    controller = relay.Controller()

    with pytest.raises(relay.RelayAccountError, match="IPWO_PROXY_AUTH_FAILED"):
        controller.fetch(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi",
            True,
        )
    with pytest.raises(relay.RelayAccountError, match="IPWO_PROXY_AUTH_FAILED"):
        controller.fetch(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi",
            True,
        )

    assert len(calls) == 1


def test_ipwo_tunnel_auth_failure_latches(monkeypatch):
    calls = []

    def fake_fetch(url, allow_redirects, *, session_id=None, budget=None):
        calls.append((url, allow_redirects))
        raise relay.RelayAccountError(
            "IPWO_PROXY_AUTH_FAILED: IPWO rejected the proxy credential"
        )

    monkeypatch.setattr(relay, "_fetch_once", fake_fetch)
    controller = relay.Controller()

    with pytest.raises(relay.RelayAccountError, match="IPWO_PROXY_AUTH_FAILED"):
        controller.fetch(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi",
            True,
        )
    with pytest.raises(relay.RelayAccountError, match="IPWO_PROXY_AUTH_FAILED"):
        controller.fetch(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi",
            True,
        )

    assert len(calls) == 1


def test_ipwo_does_not_treat_target_403_as_proxy_account_failure(monkeypatch):
    url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi"

    monkeypatch.setattr(
        relay,
        "_fetch_once",
        lambda _url, _allow_redirects, *, session_id=None, budget=None: (
            403,
            {},
            b"target rejection",
            url,
        ),
    )
    controller = relay.Controller()

    response = controller.fetch(url, True)

    assert response[0] == 403
    assert controller.current_account_error() is None


def test_transient_proxy_failure_is_retried(monkeypatch):
    url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi"
    calls = []

    def fake_fetch(_url, _allow_redirects, *, session_id=None, budget=None):
        calls.append(_url)
        if len(calls) == 1:
            raise relay.RelayUpstreamError("TimeoutError")
        return 200, {}, b"ok", url

    monkeypatch.setattr(relay, "_fetch_once", fake_fetch)
    monkeypatch.setattr(relay, "MIN_INTERVAL", 0.0)
    monkeypatch.setattr(relay.time, "sleep", lambda _seconds: None)
    controller = relay.Controller()

    response = controller.fetch(url, True)

    assert response[0] == 200
    assert response[4] == 2
    assert len(calls) == 2


def test_ipwo_username_uses_requested_country_and_explicit_sid(monkeypatch):
    monkeypatch.setattr(
        relay,
        "IPWO_PROXY_USERNAME",
        "account_custom_zone_GLOBAL_sid_12345678_time_10",
    )
    monkeypatch.setattr(relay, "IPWO_PROXY_COUNTRY", "US")
    username = relay._ipwo_username_for_request("10001234")

    assert username == "account_custom_zone_US_sid_10001234_time_10"


def test_ipwo_username_adds_sticky_suffix_to_rotating_account(monkeypatch):
    monkeypatch.setattr(
        relay,
        "IPWO_PROXY_USERNAME",
        "account_custom_zone_US",
    )
    monkeypatch.setattr(relay, "IPWO_PROXY_COUNTRY", "US")

    assert relay._ipwo_username_for_request("10001234") == (
        "account_custom_zone_US_sid_10001234_time_10"
    )


def test_ipwo_tunnel_407_is_recognized_without_exposing_proxy_url():
    error = OSError("Tunnel connection failed: 407 Proxy Authentication Required")

    assert relay._proxy_tunnel_status(error) == 407


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (403, "IPWO_PROXY_ACCESS_DENIED"),
        (431, "IPWO_PROXY_ACCOUNT_LIMIT"),
    ],
)
def test_ipwo_tunnel_account_failures_are_precise(monkeypatch, status, code):
    class FailingOpener:
        def open(self, _request, timeout):
            raise OSError(f"Tunnel connection failed: {status} rejected")

    monkeypatch.setattr(relay.urllib.request, "build_opener", lambda *_args: FailingOpener())

    with pytest.raises(relay.RelayAccountError, match=code):
        relay._fetch_once("https://example.com", False, session_id="10001234")


def test_controller_reuses_sid_until_failure_then_rotates(monkeypatch):
    url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi"
    session_ids = []

    def fake_fetch(_url, _allow_redirects, *, session_id=None, budget=None):
        session_ids.append(session_id)
        if len(session_ids) == 2:
            raise relay.RelayUpstreamError("TimeoutError")
        return 200, {}, b"ok", url

    generated = iter(["10000001", "10000002"])
    monkeypatch.setattr(relay, "_new_ipwo_session_id", lambda: next(generated))
    monkeypatch.setattr(relay, "_fetch_once", fake_fetch)
    monkeypatch.setattr(relay, "MIN_INTERVAL", 0.0)
    monkeypatch.setattr(relay.time, "sleep", lambda _seconds: None)
    controller = relay.Controller()

    assert controller.fetch(url, True)[0] == 200
    assert controller.fetch(url, True)[0] == 200

    assert session_ids == ["10000001", "10000001", "10000002"]
    assert controller.current_rotation_count() == 1


def test_slow_upstream_request_does_not_block_another_request(monkeypatch):
    first_started = threading.Event()
    release_first = threading.Event()
    second_finished = threading.Event()
    calls = []

    def fake_fetch(url, _allow_redirects, *, session_id=None, budget=None):
        calls.append(url)
        if url.endswith("first"):
            first_started.set()
            assert release_first.wait(2)
        else:
            second_finished.set()
        return 200, {}, b"ok", url

    monkeypatch.setattr(relay, "_fetch_once", fake_fetch)
    monkeypatch.setattr(relay, "MIN_INTERVAL", 0.0)
    controller = relay.Controller()
    first = threading.Thread(target=controller.fetch, args=("https://test/first", True))
    second = threading.Thread(target=controller.fetch, args=("https://test/second", True))
    first.start()
    assert first_started.wait(1)
    second.start()
    try:
        assert second_finished.wait(1)
    finally:
        release_first.set()
        first.join(2)
        second.join(2)
    assert calls == ["https://test/first", "https://test/second"]


def test_wikipedia_controller_pool_uses_independent_sticky_lanes(monkeypatch):
    url = "https://en.wikipedia.org/w/api.php"
    session_ids = []

    def fake_fetch(_url, _allow_redirects, *, session_id=None, budget=None):
        session_ids.append(session_id)
        return 200, {}, b"ok", url

    generated = iter(["10000001", "10000002"])
    monkeypatch.setattr(relay, "_new_ipwo_session_id", lambda: next(generated))
    monkeypatch.setattr(relay, "_fetch_once", fake_fetch)
    monkeypatch.setattr(relay, "MIN_INTERVAL", 0.0)
    pool = relay.ControllerPool(2)

    assert pool.fetch(url, True)[0] == 200
    assert pool.fetch(url, True)[0] == 200
    assert pool.fetch(url, True)[0] == 200

    assert session_ids == ["10000001", "10000002", "10000001"]


def test_controller_pool_latches_account_failure_across_lanes(monkeypatch):
    calls = 0

    def fake_fetch(_url, _allow_redirects, *, session_id=None, budget=None):
        nonlocal calls
        calls += 1
        raise relay.RelayAccountError("IPWO_PROXY_AUTH_FAILED: rejected")

    monkeypatch.setattr(relay, "_fetch_once", fake_fetch)
    pool = relay.ControllerPool(2)
    with pytest.raises(relay.RelayAccountError, match="IPWO_PROXY_AUTH_FAILED"):
        pool.fetch("https://en.wikipedia.org/w/api.php", True)
    with pytest.raises(relay.RelayAccountError, match="IPWO_PROXY_AUTH_FAILED"):
        pool.fetch("https://en.wikipedia.org/w/api.php", True)
    assert calls == 1


def test_json_response_treats_broken_pipe_as_client_disconnect():
    class BrokenWriter:
        def write(self, _body):
            raise BrokenPipeError(32, "broken pipe")

    handler = object.__new__(relay.Handler)
    handler.wfile = BrokenWriter()
    handler.request_version = "HTTP/1.1"
    handler.command = "POST"
    handler.requestline = "POST /v1/fetch HTTP/1.1"
    handler.send_response = lambda _status: None
    handler.send_header = lambda _name, _value: None
    handler.end_headers = lambda: None

    assert handler._json(200, {"status": "ok"}) is False


@pytest.mark.parametrize(
    ("url", "group"),
    [
        ("https://export.arxiv.org/api/query", "arxiv"),
        ("https://export.arxiv.org/pdf/2501.00001", "arxiv"),
        ("https://arxiv.org/abs/2501.00001", "arxiv"),
        ("https://arxiv.org/pdf/2501.00001", "arxiv"),
        ("https://arxiv.org/html/2501.00001", "arxiv"),
        ("https://arxiv.org/e-print/2501.00001", "arxiv"),
        ("https://arxiv.org/src/2501.00001", "arxiv"),
        ("https://www.arxiv.org/src/2501.00001", "arxiv"),
        ("https://nominatim.openstreetmap.org/search", "osm-nominatim"),
        ("https://overpass-api.de/api/interpreter", "osm-overpass"),
        ("https://router.project-osrm.org/route/v1/car/1,2;3,4", "osm-routing"),
    ],
)
def test_relay_allows_only_named_arxiv_and_osm_paths(url, group):
    assert relay._validate_url(url) == group


@pytest.mark.parametrize(
    "url",
    [
        "https://export.arxiv.org/unknown",
        "https://nominatim.openstreetmap.org/status.php",
        "https://overpass-api.de/",
        "https://example.com/api/query",
    ],
)
def test_relay_rejects_unapproved_arxiv_and_osm_paths(url):
    with pytest.raises(ValueError, match="allowed MCP egress"):
        relay._validate_url(url)


def test_relay_allows_arxiv_eprint_redirect_to_source_archive():
    request = relay.urllib.request.Request(
        "https://arxiv.org/e-print/1706.03762",
    )
    redirected = relay.SafeRedirect().redirect_request(
        request,
        None,
        301,
        "Moved Permanently",
        {},
        "https://arxiv.org/src/1706.03762",
    )

    assert redirected is not None
    assert redirected.full_url == "https://arxiv.org/src/1706.03762"


def test_controller_forwards_post_body_and_headers(monkeypatch):
    captured = {}

    def fake_fetch(url, allow_redirects, **kwargs):
        captured.update(url=url, allow_redirects=allow_redirects, **kwargs)
        return 200, {}, b"{}", url

    monkeypatch.setattr(relay, "_fetch_once", fake_fetch)
    controller = relay.Controller(0)
    response = controller.fetch(
        "https://overpass-api.de/api/interpreter",
        True,
        method="POST",
        body=b"data=query",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )

    assert response[0] == 200
    assert captured["method"] == "POST"
    assert captured["body"] == b"data=query"
    assert captured["headers"]["Content-Type"] == "application/x-www-form-urlencoded"


@pytest.fixture(autouse=True)
def temporary_audit_path(monkeypatch, tmp_path):
    monkeypatch.setattr(relay, "LOG_PATH", tmp_path / "usage.jsonl")
    monkeypatch.setattr(relay, "LIMITS_PATH", tmp_path / "limits.json")


def test_live_limits_validate_and_persist(monkeypatch, tmp_path):
    old = relay.current_limits()
    values = {name: dict(value) for name, value in old.items()}
    values["wikipedia"] = {"minIntervalMs": 500, "concurrency": 2}
    try:
        relay.apply_limits(values)
        assert relay.current_limits()["wikipedia"] == values["wikipedia"]
        assert __import__("json").loads(relay.LIMITS_PATH.read_text()) == values
        invalid = dict(values)
        invalid["wikipedia"] = {"minIntervalMs": -1}
        with pytest.raises(ValueError):
            relay.apply_limits(invalid)
        assert relay.current_limits() == values
    finally:
        relay.apply_limits(old, persist=False)


def test_ncbi_key_and_pmc_have_separate_http_policies():
    assert relay.controller_for_url("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?api_key=test", "ncbi") is relay.CONTROLLERS["ncbi-key"]
    assert relay.controller_for_url("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", "ncbi") is relay.CONTROLLERS["ncbi"]
    assert relay.controller_for_url("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123", "ncbi") is relay.CONTROLLERS["ncbi-pmc"]


def test_each_http_attempt_is_logged_without_query_or_keys(monkeypatch, tmp_path):
    url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?api_key=do-not-log&term=private-query"
    monkeypatch.setattr(relay, "_fetch_once", lambda target, redirects, **kwargs: (200, {}, b"private body", target))
    relay.Controller(0).fetch(url, False)
    raw = relay.LOG_PATH.read_text()
    records = [__import__("json").loads(line) for line in raw.splitlines()]
    records = [r for r in records if r["event"] in {"http_started", "http_finished"}]
    assert [item["event"] for item in records] == ["http_started", "http_finished"]
    assert records[0]["request_id"] == records[1]["request_id"]
    assert "do-not-log" not in raw and "private-query" not in raw and "private body" not in raw


def wait_until(predicate, timeout=1):
    import time
    end = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < end
        time.sleep(0.005)


def test_fifo_admission_and_expired_waiter_do_not_leave_ghost_requests(monkeypatch):
    controller = relay.Controller(0)
    controller.max_concurrency = 1
    started = threading.Event()
    release = threading.Event()
    calls, errors = [], []

    def upstream(url, redirects, **kwargs):
        calls.append(url)
        if url.endswith('/first'):
            started.set()
            assert release.wait(2)
        return 200, {}, b'ok', url

    monkeypatch.setattr(relay, '_fetch_once', upstream)
    def run(name, timeout=2):
        try:
            controller.fetch('https://test/' + name, False, budget=relay.RequestBudget(timeout))
        except Exception as exc:
            errors.append((name, exc))
    first = threading.Thread(target=run, args=('first',)); first.start()
    assert started.wait(1)
    expired = threading.Thread(target=run, args=('expired', 0.05)); expired.start()
    wait_until(lambda: len(controller.pending) == 1)
    second = threading.Thread(target=run, args=('second',)); second.start()
    wait_until(lambda: len(controller.pending) == 2)
    third = threading.Thread(target=run, args=('third',)); third.start()
    expired.join(1)
    assert not expired.is_alive()
    assert len(errors) == 1 and isinstance(errors[0][1], relay.RelayRequestExpired)
    release.set()
    for thread in (first, second, third):
        thread.join(2); assert not thread.is_alive()
    assert calls == ['https://test/first', 'https://test/second', 'https://test/third']
    assert controller.active == 0 and not controller.pending


def test_retry_rejoins_fifo_and_does_not_hold_network_slot(monkeypatch):
    controller = relay.Controller(0)
    controller.max_concurrency = 1
    first_started, release = threading.Event(), threading.Event()
    calls, results = [], []
    cooldown = controller._set_cooldown
    monkeypatch.setattr(controller, '_set_cooldown', lambda seconds: cooldown(0.05))

    def upstream(url, redirects, **kwargs):
        calls.append(url)
        if len(calls) == 1:
            first_started.set(); assert release.wait(2)
            return 429, {}, b'limited', url
        return 200, {}, b'ok', url

    monkeypatch.setattr(relay, '_fetch_once', upstream)
    def run(name):
        results.append(controller.fetch('https://test/' + name, False))
    first = threading.Thread(target=run, args=('retry',)); first.start()
    assert first_started.wait(1)
    other = threading.Thread(target=run, args=('other',)); other.start()
    wait_until(lambda: len(controller.pending) == 1)
    release.set()
    wait_until(lambda: len(controller.pending) == 2)
    assert controller.active == 0
    for thread in (first, other):
        thread.join(2); assert not thread.is_alive()
    assert calls == ['https://test/retry', 'https://test/other', 'https://test/retry']
    assert sorted(result[4] for result in results) == [1, 2]
    assert all(result[0] == 200 for result in results)


def test_cancelled_waiter_is_removed_without_upstream_call(monkeypatch):
    controller = relay.Controller(0)
    controller.max_concurrency = 1
    controller.active = 1
    cancelled = threading.Event()
    errors = []
    monkeypatch.setattr(relay, '_fetch_once', lambda *a, **k: pytest.fail('cancelled request sent'))
    def run():
        try:
            controller.fetch('https://test/', False, budget=relay.RequestBudget(2, cancelled.is_set))
        except Exception as exc:
            errors.append(exc)
    thread = threading.Thread(target=run); thread.start()
    wait_until(lambda: len(controller.pending) == 1)
    cancelled.set(); thread.join(1)
    assert not thread.is_alive() and isinstance(errors[0], relay.RelayRequestCancelled)
    assert not controller.pending and controller.active == 1


def test_cooldown_exceeding_budget_stops_retry(monkeypatch):
    controller = relay.Controller(0)
    calls = []
    def upstream(url, redirects, **kwargs):
        calls.append(url)
        return 429, {'Retry-After': '60'}, b'limited', url
    monkeypatch.setattr(relay, '_fetch_once', upstream)
    with pytest.raises(relay.RelayRequestExpired, match='queue'):
        controller.fetch('https://test/', False, budget=relay.RequestBudget(0.05))
    assert len(calls) == 1 and controller.active == 0 and not controller.pending


def test_response_watchdog_interrupts_blocking_read_on_deadline():
    import socket
    import time
    reader, writer = socket.socketpair()
    start = time.monotonic()
    try:
        with relay._watch_socket(reader, relay.RequestBudget(0.05)):
            assert reader.recv(1) == b''
        assert time.monotonic() - start < 0.5
    finally:
        reader.close(); writer.close()


@pytest.fixture
def http_relay(monkeypatch):
    from http.server import ThreadingHTTPServer
    monkeypatch.setattr(relay, 'TOKEN', 'test-relay-token')
    server = ThreadingHTTPServer(('127.0.0.1', 0), relay.Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        yield server.server_address
    finally:
        server.shutdown(); server.server_close(); thread.join(1)


def test_http_queue_timeout_is_classified_and_logged(http_relay, monkeypatch):
    import json
    import urllib.request
    controller = relay.Controller(0)
    controller._set_cooldown(1)
    monkeypatch.setattr(relay, 'controller_for_url', lambda *a: controller)
    monkeypatch.setattr(relay, '_fetch_once', lambda *a, **k: pytest.fail('expired request sent'))
    payload = json.dumps({'url': 'https://export.arxiv.org/api/query', 'timeout_seconds': 0.05}).encode()
    req = urllib.request.Request('http://%s:%s/v1/fetch' % http_relay, data=payload,
                                 headers={'Authorization': 'Bearer test-relay-token'})
    with pytest.raises(urllib.error.HTTPError) as caught:
        urllib.request.urlopen(req, timeout=2)
    assert caught.value.code == 504
    assert json.loads(caught.value.read())['code'] == 'queue_timeout'
    records = [json.loads(line) for line in relay.LOG_PATH.read_text().splitlines()]
    summary = next(r for r in records if r['event'] == 'http_completed')
    assert summary['status'] == 504 and summary['attempts'] == 0
    assert summary['queued_ms'] >= 40 and summary['request_id']
    assert not controller.pending and controller.active == 0


def test_http_disconnect_cancels_queued_request_and_next_request_recovers(http_relay, monkeypatch):
    import json
    import socket
    import urllib.request
    controller = relay.Controller(0)
    controller.max_concurrency = 1
    controller.active = 1
    calls = []
    monkeypatch.setattr(relay, 'controller_for_url', lambda *a: controller)
    def upstream(url, redirects, **kwargs):
        calls.append(url); return 200, {}, b'ok', url
    monkeypatch.setattr(relay, '_fetch_once', upstream)
    body = json.dumps({'url': 'https://export.arxiv.org/api/query', 'timeout_seconds': 2}).encode()
    sock = socket.create_connection(http_relay)
    sock.sendall(b'POST /v1/fetch HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test-relay-token\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
    wait_until(lambda: len(controller.pending) == 1)
    sock.shutdown(socket.SHUT_RDWR); sock.close()
    wait_until(lambda: len(controller.pending) == 0)
    assert calls == []
    def cancelled_logged():
        return any(json.loads(l).get('category') == 'client_cancelled'
                   for l in relay.LOG_PATH.read_text().splitlines())
    wait_until(cancelled_logged)
    with controller.slots:
        controller.active = 0; controller.slots.notify_all()
    req = urllib.request.Request('http://%s:%s/v1/fetch' % http_relay, data=body,
                                 headers={'Authorization': 'Bearer test-relay-token'})
    with urllib.request.urlopen(req, timeout=2) as response:
        assert json.load(response)['status_code'] == 200
    assert len(calls) == 1


def test_http_retry_returns_success_in_one_client_call(http_relay, monkeypatch):
    import json
    import urllib.request
    controller = relay.Controller(0)
    monkeypatch.setattr(controller, '_set_cooldown', lambda seconds: None)
    monkeypatch.setattr(relay, 'controller_for_url', lambda *a: controller)
    attempts = []
    def upstream(url, redirects, **kwargs):
        attempts.append(url)
        return (429 if len(attempts) == 1 else 200), {}, b'ok', url
    monkeypatch.setattr(relay, '_fetch_once', upstream)
    body = json.dumps({'url': 'https://export.arxiv.org/api/query'}).encode()
    req = urllib.request.Request('http://%s:%s/v1/fetch' % http_relay, data=body,
                                 headers={'Authorization': 'Bearer test-relay-token'})
    with urllib.request.urlopen(req, timeout=2) as response:
        assert json.load(response)['status_code'] == 200
    assert len(attempts) == 2
    records = [json.loads(l) for l in relay.LOG_PATH.read_text().splitlines()]
    parent_ids = {r['parent_request_id'] for r in records if r['event'] == 'http_started'}
    summary = next(r for r in records if r['event'] == 'http_completed')
    assert parent_ids == {summary['request_id']} and summary['attempts'] == 2


def test_many_expired_requests_do_not_block_a_new_request(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    controller = relay.Controller(0)
    controller.max_concurrency = 1
    controller.active = 1
    calls = []
    def upstream(url, redirects, **kwargs):
        calls.append(url); return 200, {}, b'ok', url
    monkeypatch.setattr(relay, '_fetch_once', upstream)
    def expired(_):
        try:
            controller.fetch('https://test/expired', False, budget=relay.RequestBudget(0.05))
        except relay.RelayRequestExpired:
            return 'expired'
    with ThreadPoolExecutor(max_workers=40) as pool:
        assert list(pool.map(expired, range(40))) == ['expired'] * 40
    assert calls == [] and not controller.pending
    controller.active = 0
    assert controller.fetch('https://test/new', False)[0] == 200
    assert calls == ['https://test/new'] and controller.active == 0


def test_twenty_concurrent_calls_succeed_with_pacing_and_single_network_slot(monkeypatch):
    import time
    from concurrent.futures import ThreadPoolExecutor
    controller = relay.Controller(0.005)
    controller.max_concurrency = 1
    starts = []
    active = peak = 0
    lock = threading.Lock()
    def upstream(url, redirects, **kwargs):
        nonlocal active, peak
        with lock:
            active += 1; peak = max(peak, active); starts.append(time.monotonic())
        time.sleep(0.002)
        with lock:
            active -= 1
        return 200, {}, b'ok', url
    monkeypatch.setattr(relay, '_fetch_once', upstream)
    with ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(lambda i: controller.fetch(f'https://test/{i}', False,
                           budget=relay.RequestBudget(2)), range(20)))
    assert len(results) == 20 and all(r[0] == 200 and r[4] == 1 for r in results)
    assert peak == 1 and all(b - a >= 0.004 for a, b in zip(starts, starts[1:]))
    assert not controller.pending and controller.active == 0


def test_deadline_interrupts_slow_response_headers():
    import http.client
    import socket
    import time
    reader, writer = socket.socketpair()
    connection = relay.BudgetHTTPSConnection('unused', budget=relay.RequestBudget(0.05))
    connection.sock = reader
    connection._HTTPConnection__state = http.client._CS_REQ_SENT
    writer.sendall(b'HTTP/1.1 200 OK\r\nX-Incomplete: ')
    start = time.monotonic()
    try:
        with pytest.raises(relay.RelayRequestExpired):
            connection.getresponse()
        assert time.monotonic() - start < 0.5
    finally:
        connection.close(); writer.close()
