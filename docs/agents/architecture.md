# Architecture and data/auth invariants

Read this guide when changing runtime wiring, MCP connections, HTTP routing, authentication, persistence, or database behavior. For the public runtime overview, see [docs/development/architecture.mdx](../development/architecture.mdx).

## Runtime map

- `src/index.ts` starts the process and `src/server.ts` owns `AppServer` initialization, route registration, and shutdown.
- `src/services/mcpService.ts` owns the lifecycle of upstream MCP clients.
- `src/routes/` defines HTTP routes; `src/controllers/` implements resource handlers.
- `src/dao/` provides file-backed persistence by default; `src/db/` provides the optional TypeORM/PostgreSQL backend.
- `src/clients/` contains upstream MCP client wrappers.
- `src/types/` contains shared configuration and domain types.
- `frontend/src/` contains the Vite/React dashboard.

Target connections select operator-provided implementations and credentials by an exact
path. Implementation/version labels never select packages or override commands. Runtime
inventory counts clients and task leases, not Docker containers, and must contain metadata
only. Keep target/task inventory within the server configuration authorization boundary;
shared users must not receive other applications' task IDs or target details. See
[target connections](../features/target-connections.mdx).

## Persistence changes

When adding or changing a persisted field, update every applicable layer:

1. `src/types/index.ts` — shared interface or schema.
2. `src/dao/*Dao.ts` — JSON implementation when behavior changes.
3. `src/db/entities/*.ts` — TypeORM column; mark optional fields `nullable` and use `simple-json` for object values.
4. `src/dao/*DaoDbImpl.ts` — database create/update mapping.
5. `src/db/repositories/*.ts` — repository wrapper, when it exposes the field.
6. `src/utils/migration.ts` — JSON-to-database migration.
7. `mcp_settings.json` — example configuration, when user-facing.

Database mode is selected at startup by the code in `src/dao/DaoFactory.ts`: `USE_DB=true` enables it; when `USE_DB` is unset, a configured `DB_URL` enables it; an explicit `USE_DB=false` disables it.

## Bearer-key invariant

Bearer keys have explicit kinds. Legacy and operator-created keys use `kind: 'system'`; user-level keys use `kind: 'user'` and must have an `owner`. Do not infer the kind from whether `owner` is empty. User-level keys restore the owner's live user context on MCP transport requests and are not dashboard API credentials.

## Routing surface

- `/mcp/{group|server}` routes to a group, server, or `$smart`.
- `/:user/mcp/{group|server}` and `/:user/sse/{group}` are user-scoped variants.
- `AppServer.initialize()` in `src/server.ts` is the route-registration entry point.
- Authentication spans dashboard JWT/bcrypt, bearer keys, MCPHub's OAuth authorization server, and optional Better Auth. Inspect the current middleware and route code before changing auth behavior.

## Declarative database configuration

`MCPHUB_SETTINGS_SYNC=upsert` reconciles server/group declarations at startup only; see `src/utils/settingsSync.ts`. Keep runtime authentication state outside reconciliation. The internal server declaration fingerprint must stay out of public DAO mappings and settings exports; unchanged declarations retain upstream OAuth state, while changes invalidate it.


Calling groups (`systemConfig.userGroups`) belong to one user and contain server/target
permissions, not user memberships. Group keys restore the owner's live identity and are
bounded by both the group's grants and the owner's current visibility. New group keys
use explicit user kind; migrated operator group keys preserve their kind and token while
adding ownership. Keep dashboard configuration authorization separate from invocation
permissions. Startup migration removes legacy memberships and must never rotate keys.

## Database recovery

A health probe deadline measures both pool acquisition and query execution. One slow
probe is not proof of a broken connection: preserve the pool and reuse the pending
probe. Three consecutive timed-out rounds trigger recovery; explicit broken-connection
errors recover immediately. Health checks share one in-flight operation.

New driver pool acquisitions wait at most 10 seconds for the shared recovery promise.
Recovery initialization uses an AsyncLocalStorage context to bypass that gate. Runners
attached to a replaced DataSource fail with DatabaseRecoveringError instead of acquiring
from its ended pool. Queries already running can still fail during teardown; do not
blindly replay writes or tool calls. Generic HTTP error handling returns 503 for this
recovery error. System-config recovery must not destroy the pool for an isolated timeout.
