# Shared MCP egress Relay

The Relay accepts authenticated requests to any public HTTPS destination; no
host or path allowlist is required. HTTP, URL user information/fragments,
localhost, private/link-local/reserved IPs and DNS answers containing such IPs
are rejected. Redirects may cross public HTTPS domains and undergo the same
checks when the caller enables redirects. A request's proxy CONNECT destination
is pinned to its validated public IP, while TLS verification/SNI and the upstream
HTTPS Host header retain the original hostname. DNS lookup has a five-second
ceiling within the request's existing deadline.

`UPSTREAM_GROUPS` maps known upstreams to shared rate policies; it is not an
access allowlist. Unknown hosts have no extra request interval or concurrency
cap. Their retry/cooldown state is isolated per HTTPS origin, so one provider's
429 cannot pause unrelated providers. Existing named policies remain unchanged.
The NCBI category includes `pmc.ncbi.nlm.nih.gov`; PMC uses `ncbi-pmc`, separately
from keyed and unkeyed E-utilities traffic.

All three Overpass nodes (`overpass-api.de`, `maps.mail.ru`, and
`overpass.private.coffee`) use the shared `osm-overpass` policy. The MCP wrapper
must route every configured node through Relay. A saved `OSM_OVERPASS_URLS`
value overrides the wrapper defaults; changing Relay's access policy does not
add nodes to that value. Reload the MCP after changing its node list, and restart
Relay after updating its implementation, once active calls have finished.

This is not an unrestricted or fully transparent HTTP proxy. The existing
protocol accepts GET and POST, filters forwarded headers, limits request bodies
to 64 KiB and responses to 64 MiB by default. Those limits have not been changed
by the public HTTPS destination policy.

The dashboard Relay limits table configures each category's network wait and
complete queue/retry/network budget (seconds). Save applies to new requests without
restarting Relay; in-flight requests keep their admitted budget. Existing saved
interval/concurrency settings are preserved when the new timeout fields are absent.

| Category | Network wait | Total budget |
| --- | ---: | ---: |
| OSM Overpass | 120 | 140 |
| OSM Nominatim | 45 | 140 |
| Wikipedia | 45 | 140 |
| arXiv | 60 | 140 |
| NCBI / NCBI-key / NCBI-PMC | 60 per attempt | 210 |
| OSM routing, other public HTTPS | 45 | 85 |

The last row uses `MCP_RELAY_UPSTREAM_TIMEOUT_SECONDS` and
`MCP_RELAY_REQUEST_TIMEOUT_SECONDS` as fallback defaults. A caller's shorter
`timeout_seconds` always wins. Network wait bounds connect/header/read idle waits;
it does not grant a separate budget per retry. Total budget includes queueing,
retries, DNS validation and response reads. Logs distinguish queue deadline,
upstream total deadline and network wait timeout, including the applied budget.

The updated Atlas Relay adapters and standalone arXiv/OSM/Wikipedia packages use
a 145-second client wait for these four extended categories, reserving delivery
time. OSM endpoint fallback shares a 140-second tool deadline, below Atlas's
150-second default tool timeout; its routing attempts retain the shorter 20-second
limit. Other clients retain their existing timeout and may expire earlier.
Client overrides use the JSON object `MCP_RELAY_CLIENT_TIMEOUTS` (seconds per category).
These are operational defaults, not upstream rate-limit requirements.

Run tests with `python -m pytest tests/relay/test_egress_relay.py`.

## Persistent Overpass cache

The Relay caches credential-free GET/POST interpreter requests to the three known
Overpass mirrors. It preserves exact method, query/body bytes and allowed headers;
it never rounds coordinates, expands a search radius or matches similar queries.
Only HTTP 200 JSON objects with an `elements` array and no `remark`/`error`/`errors`
are stored, including successful empty arrays. Invalid JSON, partial results,
upstream errors and timeouts are not cached. Raw response body bytes are replayed
unchanged; this is a dated snapshot, not a guarantee of live upstream freshness.

`MCP_RELAY_OVERPASS_CACHE_ENABLED` defaults to `true`. The SQLite database defaults
to `overpass-cache.sqlite3` beside the usage log, inside the mounted data directory.
`MCP_RELAY_OVERPASS_CACHE_PATH` overrides that path. Default TTL is 30 days
(`MCP_RELAY_OVERPASS_CACHE_DAYS`); weekly refresh is controlled by
`MCP_RELAY_OVERPASS_REFRESH_DAYS` (7). Restart Relay after changing these settings.
Keep `overpass_cache.py` beside `egress_relay.py` when deploying Relay independently.

Identical concurrent cache misses share the successful network response within
one Relay process, and each caller retains its deadline/cancellation. Storage
failures bypass cache and use the ordinary upstream path. The hourly maintenance
check refreshes at most 50 due entries sequentially, five seconds apart. It only
refreshes entries used within the retention window; failures retain the prior
success without extending its TTL and are retried no sooner than the next day.
Valid cached readers do not wait for background refresh. Existing Relay limits,
authentication and URL validation still apply. First-time/unmatched queries can
still fail upstream.

Cache hits emit `cache_hit` rather than `http_finished`/`http_completed`, so they
are distinguishable in the call-log UI and do not count as upstream HTTP attempts.
Model-side tool calls are still recorded normally. The cache is public Overpass
data only; requests with non-allowlisted headers bypass it.

### Prewarm actual benchmark requests

The helper reads actual completion CSV `trajectory` fields or pipeline teacher
histories. It never reads reference `TRAJECTORY`/claims or derives answers.
Collection makes no network requests:

```bash
python3 scripts/prewarm_osm_cache.py /path/to/completion.csv \
  --output /path/to/prewarm-requests.json
```

Run with a Python environment containing the MCP SDK, and provide a Hub group key
via `MCPHUB_TOKEN` (not an upstream key). The endpoint and account are configurable:

```bash
python3 scripts/prewarm_osm_cache.py /path/to/prewarm-requests.json \
  --execute --url http://192.168.0.22:3003/mcp/atlas/osm-mcp-server \
  --target official --limit 20 --interval 5
```

Each prewarm call goes through Hub authentication, logging and the normal MCP
implementation, one at a time. Failures are reported but never inserted as valid
cache entries. Re-running is safe; already cached requests use the stored data.

The helper saves atomic per-request progress beside its input file, using
`.progress.json` (`--state` overrides it). Progress is scoped to the exact Hub
endpoint and account, and a file lock prevents simultaneous writers. Normal
execution skips recorded successes, prioritizes unstarted items, and then resumes
failures with fewer attempts first. Each selected item is attempted at most once
per pass, so a bad early request cannot starve the rest of the manifest.
`--retry-errors` selects **only** previously failed/interrupted items; it does not
select successes or unstarted work. If interrupted during a call, that entry stays
retryable. Transport failures stop the pass rather than marking all remaining
entries as errors. The progress file describes one prewarm campaign; use a new
`--state` file when deliberately starting a new campaign after cache expiration
or replacing the cache.

```bash
# Keep the same input, URL, target and group key as the original command.
python3 scripts/prewarm_osm_cache.py /path/to/prewarm-requests.json \
  --execute --limit 915 --interval 5 --retry-errors
```

Explicit upstream overload/429 pauses the pass immediately. Three consecutive
transient upstream errors/timeouts also pause it, because an MCP may conceal the
underlying node response. The process waits 300 seconds (`--pause-seconds`), with
a countdown every 30 seconds, then probes with the next selected request. If that
probe fails transiently, it waits again instead of sending another burst. The
MCP session is closed during the pause and recreated on recovery, avoiding idle
event-stream timeouts. Failures remain retryable; they are not replayed within
the same pass. Ctrl+C preserves all recorded progress. `--status` reads saved
progress and running/waiting state without making network requests, even while
another process is executing the campaign. True Hub transport failures stop
safely instead of poisoning the remainder of the pass.

This is prewarm-only protection and does not alter model tool calls or Relay rate
policies. Errors and elapsed time are printed with credential redaction, without
request arguments or successful response bodies. The script cannot make an
unavailable public server healthy or guarantee every query will eventually warm.

IPWO mode follows `IPWO_PROXY_USERNAME`: without a `sid` parameter, Relay leaves
the username in rotating mode and lets IPWO select each connection's exit.
It never appends a sticky `sid` or `time`. An explicitly configured sticky
username retains its time setting and uses a per-category session that changes
after failure. `IPWO_PROXY_COUNTRY` remains an explicit country override.
Changing a selection on IPWO's website does not update the running Relay's
environment: save the generated username in the deployment configuration and
restart Relay after active evaluations have stopped. `/health` reports
`rotating_per_request` or `sticky_until_failure`; this reflects configuration,
not a measurement or guarantee of different IPs on every request.

## Bounded arXiv concurrency experiment

The dashboard's Relay limits configure `arxiv.concurrency` and `minIntervalMs`.
Concurrency counts network attempts, including retries; excess attempts join the
same FIFO queue. Raising concurrency does not remove the minimum start interval.

With rotating IPWO credentials (no `_sid_`), arXiv HTTP 429, 5xx and retryable
network failures do not impose shared cooldowns or additional retry delays.
Each retry opens a new proxy connection and rejoins FIFO admission; configured
spacing and concurrency still apply. Retry-After remains visible in the upstream
response/log but does not pause unrelated rotating exits. The three-attempt
maximum (first request plus two retries), total request budget and cancellation
remain in effect. A new connection does not guarantee a different actual IP.

For sticky credentials, `MCP_RELAY_ARXIV_IMMEDIATE_TIMEOUT_RETRY=true` disables
extra backoff only for arXiv socket/connect/read timeouts and HTTP 504 without
Retry-After. Other failures retain their existing cooldowns. Other upstream
groups retain their policies. This is an experiment, not a claim that the arXiv
API permits multiple simultaneous connections.


## Failed-response diagnostics

Failed HTTP attempts and completed failed requests record fixed-vocabulary response
metadata: content format, recognized server product, presence of `Via`, an error
reason, a source hint and a SHA-256 response fingerprint. NCBI XML and common proxy
error pages can provide useful source hints; these hints do not prove the origin
of every failure. Raw response text, arbitrary response headers, URL queries and
credentials are not persisted. Success responses do not add these diagnostics.
Diagnostic extraction does not change response bytes, retry limits, cooldowns or
upstream quotas.


## Overpass endpoint fallback

Configured Overpass nodes share the operator's category-wide start interval and
concurrency limit. Each Relay fetch makes one network attempt, returning its
original HTTP status/body or network failure to the MCP's existing fallback.

With rotating IPWO credentials (no `_sid_`), Overpass failures never create shared
node or group cooldowns, including for HTTP 429/Retry-After, 5xx, network errors or
upstream timeouts. Subsequent callers can try the same node through another proxy
exit. This does not guarantee a different actual IP or a healthy upstream. The
existing request deadline, cancellation, interval and concurrency controls remain.

Sticky credentials retain per-origin cooldowns: transient failures cool a node for
five seconds; HTTP 429 respects Retry-After with a minimum sixty seconds. A cooling
node is skipped without occupying the shared queue. Queue cancellation does not
cool a healthy node. Other upstream groups retain their existing retry/cooldown
policies.

NCBI makes at most three attempts, including the first, with a fresh exit on
retry. Its 60-second attempt deadline spans connection, headers and response
reads; it is not reset by trickling bytes. All attempts, queueing and backoff
share the 210-second request budget. Cancellation and a caller's shorter total
budget still win. Persisted custom limits are retained: update existing NCBI
rows to 60/210 in the dashboard to adopt these defaults. PubMed clients need
at least a 225-second HTTP timeout and enough tool time for two HTTP calls.

Per-request callers may optionally send a positive finite `network_timeout_seconds`
in `/v1/fetch`. It reduces the upstream socket/attempt budget after admission; it
cannot increase the configured provider network limit. `timeout_seconds` separately
caps the entire workflow including queues and existing retries, and still cannot
raise the provider's configured total limit or the Relay's 600-second ceiling.
Omitting the new field preserves existing callers' behavior.

### arXiv query cache

Public HTTPS `/api/query` GET and form POST requests use a persistent SQLite cache
by default. `MCP_RELAY_ARXIV_CACHE_ENABLED=false` disables it;
`MCP_RELAY_ARXIV_CACHE_HOURS` defaults to 24. The database is
`arxiv-query-cache.sqlite3` beside the usage log (on the mounted data directory),
or the path set by `MCP_RELAY_ARXIV_CACHE_PATH`. Restart Relay to change settings.
Keep `arxiv_cache.py` beside `egress_relay.py` for independent deployment.

Only complete HTTP 200 Atom feeds with valid OpenSearch metadata are stored.
Error feeds, malformed XML, 429, timeouts and authenticated requests are not cached.
Exact URL/query bytes, request body, method, safe headers and redirect policy select
the cache; pagination and sorting are never merged. Responses preserve the original
XML bytes and decoding headers. A hit can omit new/updated papers until its 24-hour
TTL expires. Hits do not extend TTL. Expired entries are not served on failure and
are pruned when saving new successes. There is no prewarm or background network refresh.

Concurrent identical requests share one in-flight network operation (including its
existing Relay retries), even if that operation returns an HTTP error. Shared errors
are never persisted. Each waiting caller retains its own deadline and cancellation.
Cache/storage failure uses the ordinary upstream path. `cache_hit` records stored
responses; `http_coalesced` records shared in-flight responses. Both have zero new
upstream attempts; actual HTTP attempts retain their existing records. Source/PDF/HTML
downloads and `/format` are unchanged. No MCP schemas or benchmark code are changed.
