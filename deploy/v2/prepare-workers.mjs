#!/usr/bin/env node
// Initialize private worker routing in the single root .env without rotating tokens.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const filename = path.resolve(process.argv[2] || path.join(repo, '.env'));
const current = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
const env = dotenv.parse(current);
const workers = env.MCPHUB_WORKERS ? JSON.parse(env.MCPHUB_WORKERS) : {};
const additions = {};
for (const catalog of ['atlas', 'toolathlon']) {
  const key = `MCPHUB_${catalog.toUpperCase()}_WORKER_TOKEN`;
  const saved = workers[catalog];
  if (env[key] && saved?.token && env[key] !== saved.token)
    throw new Error(`Worker token mismatch for ${catalog}; refusing to rotate credentials`);
  const token = env[key] || saved?.token || crypto.randomBytes(32).toString('hex');
  if (typeof token !== 'string' || token.length < 32 || /[\s']/.test(token))
    throw new Error(`Invalid worker token for ${catalog}`);
  if (!env[key]) additions[key] = token;
  workers[catalog] = { catalog, url: `ws://${catalog}-worker:3100/stdio`, token, ...saved };
  if (!env.MCPHUB_WORKERS)
    for (const directory of [
      `workers/${catalog}`,
      `runtime/uploads/mcpb/catalogs/${catalog}`,
      `runtime/usage/catalogs/${catalog}`,
    ])
      fs.mkdirSync(path.join(repo, 'data/v2-container', directory), {
        recursive: true,
        mode: 0o700,
      });
}
if (!env.MCPHUB_WORKERS) additions.MCPHUB_WORKERS = JSON.stringify(workers);
if (!env.MCPHUB_REQUIRE_WORKERS) additions.MCPHUB_REQUIRE_WORKERS = 'true';
if (!env.MCPHUB_INTERNAL_URL) additions.MCPHUB_INTERNAL_URL = 'http://hub:3000';
if (Object.keys(additions).length) {
  fs.appendFileSync(
    filename,
    '\n# Execution workers\n' +
      Object.entries(additions)
        .map(([key, value]) => `${key}='${value}'`)
        .join('\n') +
      '\n',
    { mode: 0o600 },
  );
}
fs.chmodSync(filename, 0o600);
console.log('Worker routing prepared in root .env; existing tokens preserved.');
