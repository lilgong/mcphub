# Local v2 container deployment

This deployment belongs only to `/home/lny/mcphub-v2`. Production `mcphub`,
`mcphub-db`, port 3002 and the external Relay are not managed by this Compose project.

- `mcphub-v2`: Hub, public-space MCPs, authorization, shared scheduling and logs; container port 3000.
- `mcphub-v2-atlas`: resident Atlas MCP processes, private control endpoint only.
- `mcphub-v2-toolathlon`: resident Toolathlon MCP processes, private control endpoint only.
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
node deploy/v2/prepare-workers.mjs
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

## Isolated MCP execution

For a new deployment run `node deploy/v2/prepare-workers.mjs` before Compose. It
creates private worker env files, preserves existing worker control tokens and does
not rotate any benchmark Hub key. Worker endpoints have no published host ports.
Each worker joins a separate network with Hub and has no database env or Docker socket.
Public MCPs stay in Hub; named-space STDIO processes require an explicit worker route.
HTTP/SSE registrations already connect to external services. Task MCPs remain in their
benchmark task containers, including Toolathlon Kind nodes.

For an existing deployment, first back up PostgreSQL, configuration and credentials.
Capture a private server snapshot and use `prepare-worker-layout.mjs snapshot.json
runtime-dir output.private.json` to stage code and rewritten paths without touching
DB or running processes. It refuses an already staged destination. Apply only changed
`args`, `env`, `targets` under a DB transaction during the Hub maintenance interval,
then start workers and Hub. Do not import the old JSON seed over the live database.
Keep the old files and image until discovery, target permissions, key pools and logs
are verified. The initial v2 migration script is not an upgrade tool.

Namespace bundle paths are visible read-only at `/app/packages` in each worker;
private immutable snapshots live at `/app/data/releases`. New uploads and reloads
need no manual package copy. Credentials remain in Hub and are sent only to the
selected process. Slack caches and provider quota state belong in that worker's
private data; preserve existing state during migration. Provider logs share only
`runtime/usage/catalogs/<catalog>` back to Hub. Relay itself is not restarted.

For additional containers, add a worker service/network/data directory and a worker
entry in `workers.env`. A `servers` selection overrides the catalog default; a
`targets` map overrides both for specific versions/accounts. Example shape:

```json
{
  "atlas": {"catalog":"atlas","url":"ws://atlas-worker:3100/stdio","token":"<random-control-token>"},
  "atlas-extra": {"catalog":"atlas","url":"ws://atlas-extra:3100/stdio","token":"<different-control-token>","targets":{"notion":["fixture3"]}}
}
```

Use WSS or a private encrypted network across hosts. Do not expose control ports to
benchmark clients. See admin `GET /api/runtime-workers` and the runtime table's
execution column. This is explicit placement, not automatic conflict detection.

### Verified deployment (2026-10-27)

Port 3003 now uses the worker layout. Atlas's 26 resident MCP registrations run as
30 upstream connections in `mcphub-v2-atlas`; arxiv/pubmed remain task callbacks.
All 185 list-level tool definitions and reported versions match the saved baseline.
Both static targets of Notion, Slack, Google Workspace and Airtable were discovered
through the existing Atlas group key. Calculator tool execution and centralized call
logs were verified. Context7/TwelveData worker key-pool callbacks were authenticated
without sending upstream API requests. Toolathlon worker is ready with zero MCPs
until the operator imports its packages. Stopping that empty worker left Hub, public
Serper and Atlas calls healthy. Existing 3002 production and Relay were untouched.

Configuration/DB backups, comparison evidence and desktop/narrow viewport checks are
under ignored `data/v2-container/backups/runtime-workers-20261027/`. They contain
private data; do not commit or publish them. Existing DB keys, grants, rate limits,
Relay configuration and application files were retained. Code paths alone were
rewritten. The old image and original executable trees remain for rollback.

### Workspace account deployment (2026-10-27)

The local Compose deployment now uses `mcphub-v2:workspace-accounts-20261027-r2`
for Hub and both execution workers. PostgreSQL and v1/its Relay were not restarted.
61 registrations and all saved server configurations were preserved; Atlas retains
28 registrations, 185 tool definitions and 30 resident connections. The existing
Atlas group key successfully called calculator (`2+3` -> `5`).

Live verification covered encrypted workspace storage, run occupation, OAuth-file
writeback, stale-write rejection and cleanup of temporary test resources. The
Credentials page and external Toolathlon account template were checked against the
deployed service. Real provider OAuth refresh and a complete Toolathlon evaluation
still require operator account configuration and missing original benchmark files.
The task wrapper and template instructions are in
`/home/lny/mcp-buddle/toolathlon/工作区账号说明.md` on this host.
Private pre-deployment backups and schema comparisons are retained under
`data/v2-container/backups/workspace-accounts-20261027-114232/`.

Group permissions now filter by catalog and search together; bulk select/clear affects
only the visible results. The UI-only fix is built in
`mcphub-v2:group-space-filter-20261027` (the saved Compose image). Its frontend assets
were copied into the running Hub with an atomic index switch, retaining old chunks
for existing browser sessions. No Hub/worker container was restarted for this UI update;
running containers still report the preceding workspace-accounts-r2 image tag until
an operator recreates them. Live browser verification found 32 Toolathlon resources
and one public resource; test changes were discarded without editing saved grants.

The generated-key dialog now includes a copy button with success/failure feedback,
using the shared clipboard helper (including the HTTP fallback). This UI release is
built as `mcphub-v2:key-copy-20261027`, now selected in the saved Compose environment.
Only static assets were updated in the running Hub; no container restart or existing
key rotation occurred. Browser checks covered masked full-value copying and both
clipboard paths using synthetic keys; no real key was generated during verification.

### Startup-account editor deployment (2026-10-27)

Hub and both execution workers now run
`mcphub-v2:startup-account-editor-20261027`. Only the v2 services were recreated;
v1 (`mcphub`/3002), its database/Relay and the v2 database containers were retained.
The nullable `servers.workspaceSchema` column was added on v2 startup. Nine existing
Toolathlon registrations received metadata-only input declarations through the admin
API; transport, task targets, credentials, grants and scheduling controls were preserved.
There is no need to delete or reimport those MCPs. Atlas retained 185 tool definitions
and 30 resident connections; the original group key's calculator call returned 5.

Live checks verified the server account editor, encrypted credential persistence,
occupation locks, OAuth writeback/conflict checks and cleanup of synthetic test accounts.
No real provider account material was changed by those checks. Pre-upgrade database
and configuration backups plus metadata comparisons are retained privately under
`data/v2-container/backups/workspace-accounts-20261027-153959/`.

The account layout correction is deployed as
`mcphub-v2:task-account-toggle-20261027`. Startup accounts now live inside the task
connection panel behind an opt-in toggle, default off. Other connection modes do
not display the account editor. Disabling retains stored credentials but excludes
its declared inputs from new account-run exports (shared enabled declarations win).
Existing Atlas registrations without this schema keep their original behavior.
Live checks verified default-off state, nesting, workspace-mode hiding and filtering
of disabled synthetic account material; all test changes were discarded/removed.
v1/3002 and both database containers remained untouched. The pre-update backup is
`data/v2-container/backups/workspace-accounts-20261027-154939/`.

### 2026-10-27：声明式账号字段与可编辑配置

3003 使用镜像 `mcphub-v2:declared-account-forms-20261027`。
任务注册的 `workspaceSchema` 支持具体字段、公开默认值以及 JSON/env/text 文档；
编辑页不再要求上传账号文件。管理员可重新打开已保存账号，密钥默认隐藏，完整配置预览可编辑。
新增账号只使用公开默认值；没有修改的空授权模板不写入凭据存储。
Toolathlon 的 9 个账号类任务 MCP 更新了声明；另 15 个任务 MCP 保留本地任务状态/任务生成账号逻辑。
Calendar 客户端配置由 Toolathlon 适配器从同账号 Google 授权生成，Sheets/Forms 共用该授权。

部署前确认无任务回调、活动调用和账号租约。备份位于
`data/v2-container/backups/workspace-accounts-20261027-162701/`。
保留 61 个注册、185 个 Atlas 根工具定义、全部已有凭据记录、账号开关、连接和权限配置。
3 个 v2 应用/执行容器更新；v1、两侧数据库与外部 Relay 未重启。
验证包含 73 项 Hub 定向测试、21 项 Toolathlon 测试、A/B 账号和 JSON 表单浏览器检查及线上 API 冒烟。
未执行真实第三方账号的完整授权和全量 Toolathlon 测评。

### 2026-10-27：账号与工作区编辑排版

Hub 镜像更新为 `mcphub-v2:account-layout-20261027`，执行 worker 保持上一镜像。
多工作区用摘要行分隔，多个工作区初始折叠，每次展开一份配置；复制和删除仅位于该连接详情底部。
任务连接不再显示「删除目标」，启动账号使用明确的账号列表及当前编辑标记。
本次仅改前端和文案，无配置/凭据迁移；部署前确认无活动任务，只重启 v2 Hub，未重启 worker、数据库、3002 或 Relay。

### 2026-10-27：启动账号删除入口

Hub 镜像为 `mcphub-v2:account-delete-20261027`。启动账号详情提供删除按钮，复用已有管理员工作区删除 API；
确认文案明确其作用于整个空间内该账号的共享凭据，保留 MCP 注册和任务连接。使用中的账号前后端均拒绝删除。
浏览器使用虚拟账号验证取消、删除后选择剩余账号、删除最后一个账号及清空表单；未删除任何真实账号。
仅重启 v2 Hub，无配置和凭据迁移；worker、数据库、3002 和 Relay 保持运行。

### 2026-10-27：删除后的账号折叠与提示

Hub 使用 `mcphub-v2:account-collapse-20261027`。删除账号后清空详情选择，不自动打开剩余账号；
点击同一账号行切换展开/折叠，保留未保存输入。操作成功提示独立显示并在 3 秒后关闭，失败提示保留。
浏览器验证删除后列表收起、自动提示消失、折叠保留草稿及删除最后账号后的新建状态。
仅更新 v2 Hub，未改存储、调用路由或执行 worker。

当前 Hub 镜像 `mcphub-v2:account-field-names-20261027`：账号表单与结构化文档字段统一在中文说明后显示变量名，纯变量名标签不重复显示；仅展示调整，无凭据或导入包迁移。

### 2026-10-27：任务变量来源及默认值说明

Hub 镜像 `mcphub-v2:account-defaults-notes-20261027`。账号字段显示公开默认值，JSON 文档列出公开模板默认配置。
可选 `workspaceSchema.managed` 只用于描述任务提供/覆盖的变量及自动生成路径，不参与凭据导出、路由或限速。
Toolathlon 的 13 个注册更新了说明（9 个账号类、4 个仅任务配置类）；Google/Notion/Snowflake/GitHub 等说明范围与原任务配置一致。
仅说明的 Canvas、emails、k8s、WooCommerce 不显示无用的账号编辑开关。
已导入注册同步声明，保留账号和启用状态。备份：`data/v2-container/backups/workspace-accounts-20261027-173330/`。
69 项 Hub 定向测试、21 项 Toolathlon 测试、四类表单浏览器检查及线上 Google Cloud/WooCommerce 检查通过。
只重启 v2 Hub，未重启执行 worker、数据库、3002 或 Relay；未执行任何真实账号删除操作。

### 2026-10-27：关闭管理 API 的全局 IP 限流

Compose 显式配置 `API_RATE_LIMIT_MAX: off`，与已有 `MCP_RATE_LIMIT_MAX: off` 一起部署到 3003。
原默认管理 API 预算为同一 IP 每 15 分钟 600 次，账号及任务连接续租也计入，导致 Toolathlon 高并发时出现 429。
本次通过配置关闭两个通用 API 限流门，未修改单 MCP 限速、Relay 或登录专用限流。
只重建 v2 Hub，执行 worker、数据库和 v1 保持运行。

清理失败的 `20261027-203123` 这轮 97 个任务容器；仅按结果目录挂载精确选取，不删除结果或账号目录。
确认 7 份本地凭据与 Hub 相同后，通过管理 API 释放已过期的 account-a 占用。
备份位于 `data/v2-container/backups/workspace-accounts-20261027-210612/`。
