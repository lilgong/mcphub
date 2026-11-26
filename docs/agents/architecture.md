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

Tool discovery and smart routing preserve the upstream `inputSchema`, including its
`$schema` dialect declaration. Model API compatibility transformations belong to the
client adapter, not the MCP forwarding boundary.

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

- `/mcp/{group|server}` retains public and legacy aggregate routes.
- `/mcp/{catalog}/{server}` selects one scoped registration. Catalogs never imply aggregation or container provisioning. See [catalog namespaces](../features/catalogs.mdx).
- Canonical keys are `catalog::server`; public keys remain unchanged. Use the canonical key for storage, credentials, permissions, schedulers and task leases; use the logical name on downstream tools and benchmark callbacks. Never fall back from a catalog to a public registration.
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
Key lists remain masked. The authenticated single-key token endpoint permits repeat
viewing only by its manager (the group owner or an administrator), sends
`Cache-Control: no-store`, and never rotates a key while revealing it.
Server deletion removes its exact canonical name from calling-group grants. Group
saves and deletion cleanup share one mutation queue; group listings omit dangling
references so historical deleted resources do not inflate counts or block saves.

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

## Execution workers

`MCPHUB_WORKERS` explicitly maps catalogs/MCPs/targets to authenticated execution workers; public STDIO stays local. `WorkerStdioTransport` extends the STDIO transport contract so recovery, discovery and protocol notifications remain unchanged. Never use a worker PID with the Hub's local process killer. Workers receive only per-connection credentials and selected toolchain/helper settings, never ambient Hub secrets. They have no database or Docker socket. `MCPHUB_REQUIRE_WORKERS=true` forbids local fallback for scoped STDIO. Docker Compose owns container lifecycle; task callbacks retain benchmark ownership. Scoped uploads use per-catalog read-only mounts and worker-owned immutable releases.

Execution workers run on Linux with the `setsid` executable (util-linux). Each MCP runs in its own session/process group. Disconnect and worker shutdown share idempotent cleanup: signal the group with SIGTERM, allow one second to exit, then SIGKILL the saved group even if its leader has exited. Worker shutdown waits for pending cleanups. Package snapshots rewrite `command`, arguments and environment paths, including command-only executable bundles.

## Account workspaces

`workspaceService` stores operator-managed account material and run leases in the
existing encrypted credential DAO, using reserved `@workspace` and `@workspace-run`
identities that cannot collide with MCP names. Dashboard administrators manage account configuration. Lists remain metadata-only;
explicit per-account reads require administrator dashboard authentication and return
only the current MCP declaration’s fields with Cache-Control: no-store. Calling groups need an explicit workspace grant to
export credentials to trusted preparation/grading processes; MCP invocation grants
remain separate. Never include account values/files or run capabilities in discovery,
logs, settings exports or runtime inventory.

A workspace has one leased run. Persist only capability hashes; require the original
calling identity and live group grants for every access. OAuth file writes compare the
previous contents hash. Expired runs remain occupied until explicit administrator
recovery, rather than reusing possibly stale refresh tokens. Mutation serialization is
single-Hub-process only. Benchmarks own scripts, task IDs, paths and service lifecycle;
workspace templates are external data, not benchmark-specific Hub execution logic.

`ServerConfig.workspaceSchema` is optional metadata for startup-account inputs, stored
in both server DAO modes. It is independent of personal credentialTemplate slots and
static/task target selection. Account editing is administrator-only, scoped
to the server's declared inputs; it must preserve other MCPs' fields in the shared
catalog account. Adding this metadata must never require Atlas callers to create or
supply a workspace-run capability. Declaration payloads must not embed secret values.

Structured account documents declare their fields, format and public template in
workspaceSchema. Templates must not carry credentials. Fields and the optional full
source editor modify one document; new accounts use only public defaults. Keep file
materialization in the benchmark adapter. Generic Hub code does not encode provider
field names or execute benchmark preparation scripts.

Workspace schema `managed` entries are documentation only. Do not turn generated or
task-owned fields into operator credential inputs or export their default strings
as credentials. Managed-only declarations show guidance, not an account editor.

Workspace HTTP bindings are operator-declared fixed HTTPS upstreams whose credential
references must name a declared secret value or declared file/secret JSON field.
Forwarded SDK Authorization is temporary run material, never a source for account
storage. Stream opaque bodies, preserve encoded object paths and compression;
never inject account keys into allowlisted asset origins or follow redirects on
the server. gRPC uses unary frames and trailers without changing SDK serializers.
Raw preparation/grading and Git HTTP
requests require the owning live workspace-run capability plus live group/server
grants. Resolve account secrets again after scheduler admission; never mutate the
registered MCP environment. Reject redirects and unsafe upstreams. Audit is required
before dispatch; record credential fingerprints rather than request headers/bodies.
The API auth allowlist grants access only to this capability-protected invocation
endpoint, never to account management. This gateway does not intercept arbitrary
benchmark network access; each client/SDK must be adapted explicitly.

Tool and key audit records use asynchronous durable filesystem operations, serialized
per file. Concurrent appends share bounded batches (128 records / 256 KiB, except an
individual oversized record) and one file fsync; there is no fixed batching timer.
Each caller resolves only after its batch and directory entries have synced. A batch
failure rejects all its callers without poisoning subsequent batches.
Admission must finish before dispatching a tool or upstream credential;
HTTP, streaming HTTP and gRPC dispatchers explicitly await upstream admission.
Synchronous diagnostic producers may enqueue writes, but the audited invocation must
wait for those writes before returning. Disk errors fail admission or completion;
they must not silently drop records or block the HTTP event loop with synchronous fsync.


Workspace-run lifecycle metadata must remain bounded and secret-free. Keep only
start/heartbeat/sync timestamps, enum error/exit reasons and the run ID. Archive
the last summary under `@workspace-last-run` before deleting an active lease.
Recovery requires dashboard administrator authentication, exact current run ID
and explicit stop/authorization-review acknowledgments, even after expiry. A
calling group key cannot perform recovery. Clients remain responsible for stopping
their task processes/containers and synchronizing authorization before release.
Interactive workspace shells hold leases until shell exit; benchmark command
completion inside such a shell must not implicitly release its credentials.

Resident account configurations use encrypted `WorkspaceCredentials.serverConnections`,
keyed by the existing MCP name. `workspaceSchema.connection` opts into the shared
account editor; `enabled` selects account routing rather than single shared routing.
Only public launch metadata belongs in server target entries. Re-resolve stored
account configurations on acquisition, enforce account and MCP grants, require a bare
account selector, and never fall back to the global key when account selection fails.
Account revision/lease protection applies to launch changes as well as credentials.
The startup migration moves scoped static targets into this store and rewrites exact
group selectors with the account names, preserving target ACLs and versions. Task
adapters retain ownership of task MCP executables and process lifecycle.

Standard single connections may opt into task callbacks in the server editor. This
changes Hub routing only: the benchmark must launch its own backend and register
the callback. Do not treat the checkbox as automatic task-container provisioning.
Task routes default to no extra callback deadline or response-size cap; the
benchmark adapter retains its native client timeout.

Account `enabled` is admission-only and defaults to true for existing records. Administrators
may disable an occupied account without changing credentials or interrupting its run.
Automatic allocation skips disabled accounts; explicit allocation rejects them. Existing
capabilities still renew, synchronize OAuth and release. Status updates and OAuth file
writes share the workspace mutation queue so token rotation cannot overwrite admission state.

Call-detail searches read complete source-file snapshots before applying filters or
pagination; never impose a tail-byte or per-day source-file cap. A process-local,
bounded metadata index resumes appended files at the last complete JSONL line.
Replacement/truncation rebuilds that source. Cold reads yield between chunks;
unchanged sources reuse the index. This disposable cache contains only display/join
metadata, never request arguments, headers or raw credential material, and does
not change raw logs or persistent statistics. Dashboard refreshes must not overlap
within one filter generation or let an obsolete generation replace current results.
