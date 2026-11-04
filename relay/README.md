# Shared MCP egress Relay

The Relay admits HTTPS requests to the exact hosts in `ALLOWED_TARGETS`.
All paths and query strings on these hosts are accepted, including upstream
endpoints added after an MCP was packaged. Every redirect is checked against
the same host, scheme and port boundary. Arbitrary hosts, user information and
URL fragments remain disallowed. Requests share their host category's queue
and rate policy regardless of path.

This is not an unrestricted or fully transparent HTTP proxy. The existing
protocol accepts GET and POST, filters forwarded headers, limits request bodies
to 64 KiB and responses to 64 MiB by default. Those limits have not been changed
by the removal of path restrictions.

`MCP_RELAY_UPSTREAM_TIMEOUT_SECONDS` defaults to 45 seconds per network wait;
`MCP_RELAY_REQUEST_TIMEOUT_SECONDS` defaults to 85 seconds for the complete
queue/retry/network workflow. The caller may supply a shorter positive
`timeout_seconds`; it cannot extend the server maximum. Current MCP adapters
use a 90-second HTTP client timeout by default and reserve delivery time in
the requested Relay budget. Benchmark MCP timeouts may expire sooner.

Run tests with `python -m pytest tests/relay/test_egress_relay.py`.
