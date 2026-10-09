/* eslint-disable @typescript-eslint/no-require-imports -- Loaded by Node as a CommonJS MCP launcher. */
'use strict';
const { pathToFileURL } = require('node:url');
const { dirname, join } = require('node:path');
const { performance } = require('node:perf_hooks');

function installLimiter(axios, interval) {
  let queue = Promise.resolve();
  let lastStarted = -Infinity;
  axios.interceptors.request.use(async (config) => {
    const url = new URL(config.url, config.baseURL);
    if (url.hostname !== 'openlibrary.org') return config;
    const wait = queue.then(async () => {
      const delay = lastStarted + interval - performance.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      lastStarted = performance.now();
    });
    queue = wait.catch(() => undefined);
    await wait;
    return config;
  });
}
async function main() {
  const source = '@geobio/mcp-open-library@0.1.6';
  const { resolveEntrypoint } = require('/agent-environment/src/agent_environment/run_node_mcp.cjs');
  const entry = resolveEntrypoint(source, 'build/index.js');
  const packageFile = require.resolve('axios/package.json', { paths: [dirname(entry)] });
  const { default: axios } = await import(pathToFileURL(join(dirname(packageFile), 'index.js')).href);
  const interval = Number(process.env.OPEN_LIBRARY_MIN_INTERVAL_MS ?? 1000);
  if (!Number.isSafeInteger(interval) || interval < 0 || interval > 600000) throw new Error('Invalid OPEN_LIBRARY_MIN_INTERVAL_MS');
  // Instances created by the upstream package need the same application-wide request gate.
  const create = axios.create.bind(axios);
  axios.create = (...args) => { const instance = create(...args); installLimiter(instance, interval); return instance; };
  installLimiter(axios, interval);
  process.argv = [process.argv[0], entry];
  await import(pathToFileURL(entry).href);
}
module.exports = { installLimiter };
if (require.main === module) main().catch(() => { process.stderr.write('Open Library startup failed\n'); process.exitCode = 1; });
