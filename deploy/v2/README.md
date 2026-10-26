# Local v2 container deployment

This deployment belongs only to `/home/lny/mcphub-v2`. Production `mcphub`,
`mcphub-db`, port 3002 and the external Relay are not managed by this Compose project.

- `mcphub-v2`: Hub and its resident stdio MCP processes, container port 3000.
- `mcphub-v2-db`: separate PostgreSQL 15 with pgvector, no published DB port.
- Benchmark task containers remain owned by their benchmark. No task provisioning here.
- External Relay stays at the saved URL; starting Hub does not start or stop that Relay.
- Persistent files and DB live under ignored `data/v2-container/`. Environment files,
  seed configuration and encryption key are private; back them up with the database.

The Dockerfile reuses the validated local `mcphub:upstream-key-stats` runtime image
(base ID `sha256:a9bed646e9be926489071881f111e93601f89c5554634332d3ee74c545907771`).
It installs dependencies from this worktree's frozen lockfile and builds this worktree.
It never changes the running production container. The base must be available locally.

## First preparation and staging

From this worktree, with pnpm 10.12.4 / Node available:

```sh
node deploy/v2/migrate-runtime.mjs
# Refuses an existing destination to prevent accidental overwrite.
docker compose -f deploy/v2/compose.yaml build hub
MCPHUB_V2_PORT=3004 docker compose -f deploy/v2/compose.yaml up -d
```

The preparation copies only v2 settings, user password hashes, credential ciphertext
and its encryption key, imported MCPBs and v2 audit/usage files. It rewrites host paths
to `/app/data`, preserves JWT and all policies, generates independent DB credentials,
and does not read/import production history. Verify the source configuration has not
changed since `data/v2-container/migration.json` before switching.

## Port 3003

After staging checks, stop **only** `mcphub-v2-dev.service`, then recreate Hub with
port 3003 (the Compose default). Existing SSH/nginx forwarding is unchanged.

```sh
systemctl --user disable --now mcphub-v2-dev.service
docker compose -f deploy/v2/compose.yaml up -d --no-deps --force-recreate hub
```

Database mode becomes authoritative after initial migration. Editing the seed JSON
no longer changes configuration. Keep the encryption key: encrypted Relay bindings
cannot be recovered without it. Do not set `MCPHUB_SETTINGS_SYNC` for this deployment.

For an immediate rollback **before new configuration changes**, stop only the v2 Hub
container and re-enable/start `mcphub-v2-dev.service`. Keep the v2 DB and runtime data.
After configuration changes in DB mode, export/reconcile those changes before rolling
back to the older JSON snapshot. Never run production Compose commands from here.

## Call counts and logs

- Tool statistics count each completed Hub tool invocation once. Retries and diagnostic
  events do not add tool calls. All MCPs use the common audit entry point.
- Upstream statistics count HTTP attempts recorded by the existing provider wrappers,
  HTTP forwarding and key pools. These counts are a separate metric, never added to
  tool totals. Exa, Oxylabs, Brave Search, Weather Data and Lara keep their v1 format.
- Provider child log roots are assigned automatically as
  `usage/catalogs/<space>/<MCP>/<month>`. Public uses `_public`. This also distinguishes
  separately named registrations that use the same provider. Account targets remain
  aggregated within their MCP; tool details retain target/task metadata.
- Statistics and call details accept `catalog=atlas`, `catalog=toolathlon`, or an empty
  catalog for public. Omit the parameter for all spaces. Rows retain canonical server
  identity and report catalog separately. The dashboard exposes the same space filter.
- Existing flat provider files lack space metadata. They remain under “Legacy
  (unassigned space)” (`catalog=_legacy`) rather than being attributed by guesswork.
- Call details retain v1's bounded-tail behavior and explicitly mark truncation.
  Statistics stream the complete selected date range and deduplicate request IDs.
- Database activities retain canonical server names. Direct task/HTTP calls now also
  write metadata-only activities; the normal MCP entry point keeps its existing
  activity writer to prevent duplicate records. No production history is imported.

## Slack cache storage

The Hub assigns Slack user/channel caches per canonical registration, target and
credentials under `/app/data/.cache/mcphub/slack/`. The existing `/app/data` bind
mount persists these caches. Global `/app/.channels_cache_v2.json` and
`/app/.users_cache.json` mounts are no longer used. Old shared cache contents are
not migrated; the first scoped connection fetches fresh workspace metadata.

## LAN listener for Atlas

The current host uses ignored `deploy/v2/.env` to set
`MCPHUB_V2_BIND=192.168.0.22` and `MCPHUB_V2_PORT=3003`. This persists the
listener across Compose recreates without hardcoding a machine address in code.
Set these values for another deployment; the Compose fallback remains loopback.
Atlas shared runtime and completion use `MCPHUB_URL=http://192.168.0.22:3003`.

## Global MCP request cap

`deploy/v2/compose.yaml` explicitly sets `MCP_RATE_LIMIT_MAX=off` for the Hub
service, matching the benchmark deployment policy. This disables the shared
per-IP 480 requests/minute cap on MCP protocol routes; protocol initialization,
notifications and tool calls would otherwise all consume the same budget.
Per-MCP tool scheduling and Relay upstream HTTP limits remain configured separately.
Changing this process environment requires recreating only the Hub container;
there is currently no dashboard control for this middleware setting.
