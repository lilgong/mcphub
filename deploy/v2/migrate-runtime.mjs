// One-time preparation only. Does not stop services or modify the source files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(repo, 'data/v2-dev');
const destination = path.join(repo, 'data/v2-container');
if (fs.existsSync(path.join(destination, 'app.env')))
  throw new Error('Destination already prepared; refusing to overwrite');
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
const runtime = path.join(destination, 'runtime');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(source, 'dev.env'), 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
const mappings = [
  [path.join(repo, 'data/uploads'), '/app/data/uploads'],
  [path.join(source, 'mcp-usage'), '/app/data/usage'],
  [source, '/app/data'],
];
const rewrite = (value) => {
  if (typeof value === 'string') {
    for (const [before, after] of mappings) value = value.split(before).join(after);
    return value;
  }
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
  return value;
};
const original = fs.readFileSync(path.join(source, 'mcp_settings.json'));
const settings = rewrite(JSON.parse(original));
if (settings.systemConfig?.smartRouting?.dbUrl)
  throw new Error('Explicit smart-routing DB URL needs review before migration');
fs.writeFileSync(path.join(destination, 'source-settings.private.json'), original, { mode: 0o600 });
fs.writeFileSync(path.join(runtime, 'mcp_settings.json'), JSON.stringify(settings, null, 2), {
  mode: 0o600,
});
for (const suffix of ['credentials.json', 'credentials.key']) {
  const name = 'mcp_settings.json.' + suffix;
  if (fs.existsSync(path.join(source, name))) {
    fs.copyFileSync(path.join(source, name), path.join(runtime, name));
    fs.chmodSync(path.join(runtime, name), 0o600);
  }
}
const copy = (from, to) => {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  execFileSync('cp', ['-a', '--reflink=auto', from + '/.', to]);
};
copy(path.join(repo, 'data/uploads'), path.join(runtime, 'uploads'));
copy(path.join(source, 'home'), path.join(runtime, 'home'));
copy(path.join(source, '.cache'), path.join(runtime, '.cache'));
copy(path.join(source, 'relay'), path.join(runtime, 'relay'));
copy(path.join(source, 'usage'), path.join(runtime, 'usage'));
copy(path.join(source, 'mcp-usage'), path.join(runtime, 'usage'));
// Historical provider files have no space field. Keep them unassigned, never guess.
fs.mkdirSync(path.join(runtime, 'audit'), { recursive: true, mode: 0o700 });
for (const name of fs.readdirSync(path.join(source, 'audit'))) {
  if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    fs.copyFileSync(path.join(source, 'audit', name), path.join(runtime, 'audit', name));
}
// Shared Slack caches may belong to another workspace; rebuild scoped caches instead.
const password = crypto.randomBytes(32).toString('hex');
const db = { POSTGRES_USER: 'mcphub_v2', POSTGRES_DB: 'mcphub_v2', POSTGRES_PASSWORD: password };
const app = {
  ...rewrite(env),
  NODE_ENV: 'production',
  PORT: '3000',
  USE_DB: 'true',
  DB_URL: `postgresql://mcphub_v2:${password}@db:5432/mcphub_v2`,
  MCPHUB_SETTING_PATH: '/app/data/mcp_settings.json',
  MCPHUB_AUDIT_LOG_DIR: '/app/data/audit',
  MCP_USAGE_LOG_DIR: '/app/data/usage',
  MCPHUB_KEY_POOL_LOG_DIR: '/app/data/key-pool',
  HOME: '/root',
  MCP_REMOTE_CONFIG_DIR: '/app/data/home/.mcp-auth',
  XDG_CACHE_HOME: '/app/data/.cache',
  NPM_CONFIG_CACHE: '/app/data/.cache/npm',
};
// The existing encrypted binding/key is retained. Never rotate JWT or admin password.
delete app.MCPHUB_SETTINGS_SYNC;
for (const [filename, values] of [
  ['db.env', db],
  ['app.env', app],
]) {
  fs.writeFileSync(
    path.join(destination, filename),
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
}
const manifest = {
  created: new Date().toISOString(),
  sourceSha256: crypto.createHash('sha256').update(original).digest('hex'),
  servers: Object.keys(settings.mcpServers),
  users: settings.users.map((user) => user.username),
  auditFiles: fs.readdirSync(path.join(runtime, 'audit')),
  productionPortUntouched: 3002,
};
fs.writeFileSync(path.join(destination, 'migration.json'), JSON.stringify(manifest, null, 2), {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    prepared: destination,
    servers: manifest.servers.length,
    users: manifest.users.length,
    auditFiles: manifest.auditFiles.length,
  }),
);
