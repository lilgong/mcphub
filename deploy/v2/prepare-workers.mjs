#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(process.argv[2] || 'data/v2-container');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const workers = {};
for (const catalog of ['atlas', 'toolathlon']) {
  const filename = path.join(root, `${catalog}-worker.env`);
  let token;
  if (fs.existsSync(filename)) {
    token = fs
      .readFileSync(filename, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('MCPHUB_WORKER_TOKEN='))
      ?.split('=')[1];
    if (!token || token.length < 32) throw new Error('Invalid existing worker token file');
  } else {
    token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(
      filename,
      `MCPHUB_WORKER_CATALOG=${catalog}\nMCPHUB_WORKER_TOKEN=${token}\nHOME=/app/data/home\nXDG_CACHE_HOME=/app/data/.cache\nPORT=3100\n`,
      { mode: 0o600 },
    );
  }
  workers[catalog] = { catalog, url: `ws://${catalog}-worker:3100/stdio`, token };
  fs.mkdirSync(path.join(root, 'workers', catalog), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'runtime/uploads/mcpb/catalogs', catalog), {
    recursive: true,
    mode: 0o700,
  });
}
const routeFile = path.join(root, 'workers.env');
if (!fs.existsSync(routeFile))
  fs.writeFileSync(
    routeFile,
    `MCPHUB_WORKERS=${JSON.stringify(workers)}\nMCPHUB_REQUIRE_WORKERS=true\nMCPHUB_INTERNAL_URL=http://hub:3000\n`,
    { mode: 0o600 },
  );
console.log('Prepared two private MCP execution workers; existing control tokens preserved.');
