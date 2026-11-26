# MCPHub v2 deployment

Run all commands from the repository root. The only active dotenv configuration
is `.env` in that root. It contains Hub, database, execution-worker and Relay
settings; keep it private and back it up with the encrypted credential store.
No service reads configuration or files from another MCPHub checkout.

## Start and update

```bash
# Fresh installation only: copy .env.example, configure DB_URL and database fields.
cp .env.example .env
node deploy/v2/prepare-workers.mjs
# Build from the repository Dockerfile and public base images.
docker compose build hub
docker compose up -d
```

For an existing installation, retain its `.env` and data. Never run the copy
command over a configured installation. Ordinary operations are:

```bash
docker compose ps
docker compose logs --tail 100 hub
# Apply Hub/Relay environment edits without restarting workers or PostgreSQL.
docker compose up -d --no-deps --force-recreate hub
```

Select an existing or newly built image using `MCPHUB_V2_IMAGE` in `.env`.
`MCPHUB_V2_BIND` and `MCPHUB_V2_PORT` configure dashboard access. The default
host port is 3003. Public-space STDIO MCPs run in Hub; scoped STDIO MCPs run
in their selected private execution workers. Benchmark adapters still own
per-task containers, fixture files and callback lifetimes.

Worker containers receive only their selected token and runtime directories,
not the root `.env` or upstream account secrets. `prepare-workers.mjs` appends
missing worker settings to `.env` and preserves existing control tokens.

## Relay

The dashboard starts/stops Relay as a child of Hub. Start Relay after recreating
Hub; it does not auto-start. Port 3985 is published using
`MCPHUB_RELAY_PUBLISHED_BIND` and `MCPHUB_RELAY_PUBLISHED_PORT` in `.env`.
`MCP_RELAY_URL` must be reachable by callers and task containers.
Only one deployment may publish the selected Relay port.

Edit `IPWO_PROXY_*` in root `.env`. For rotating IPWO access use the generated
username without sticky `sid/time` parameters; Relay does not append them.
The dashboard-owned Relay token is encrypted in the database and takes precedence
over its bootstrap environment value. Resetting it is an explicit dashboard
operation. Limits and logs persist under `data/v2-container/runtime/relay/`.

## Persistent data

- `data/v2-container/postgres`: PostgreSQL database.
- `data/v2-container/runtime`: uploaded packages, encrypted credential key,
  tool audits, provider usage, Relay limits/logs and runtime caches.
- `data/v2-container/workers/<catalog>`: worker package releases and caches.

Preserve the encryption key with the database. Do not use `docker compose down -v`
as an update command. `.env` is excluded from Git and Docker build contexts;
account values, tokens and provider keys must not enter source or image layers.

The generic API/MCP IP request caps are disabled for this deployment. Per-MCP
scheduling, Relay upstream rules and connection/request deadlines still apply.
