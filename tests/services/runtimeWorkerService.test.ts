import { runtimeWorkerFor, workerEnvironment } from '../../src/services/runtimeWorkerService.js';
const original = process.env;
beforeEach(() => {
  process.env = { ...original };
});
afterEach(() => {
  process.env = original;
});
const endpoint = { catalog: 'atlas', url: 'ws://atlas-worker:3100/stdio', token: 'x'.repeat(40) };
test('public resources stay local, exact MCP routing overrides the namespace default', () => {
  process.env.MCPHUB_WORKERS = JSON.stringify({
    atlas: endpoint,
    extra: { ...endpoint, servers: ['notion'] },
  });
  process.env.MCPHUB_REQUIRE_WORKERS = 'true';
  expect(runtimeWorkerFor('serper')).toBeUndefined();
  expect(runtimeWorkerFor('atlas::notion')?.id).toBe('extra');
  expect(runtimeWorkerFor('atlas::fetch')?.id).toBe('atlas');
  expect(() => runtimeWorkerFor('toolathlon::fetch')).toThrow('No runtime worker');
});
test('ambiguous placement and invalid credential-bearing URLs fail closed', () => {
  process.env.MCPHUB_WORKERS = JSON.stringify({ atlas: endpoint, duplicate: endpoint });
  expect(() => runtimeWorkerFor('atlas::fetch')).toThrow('Ambiguous');
  process.env.MCPHUB_WORKERS = JSON.stringify({
    atlas: { ...endpoint, url: 'ws://token@worker:3100/stdio' },
  });
  expect(() => runtimeWorkerFor('atlas::fetch')).toThrow();
});
test('forwards connection credentials and provider helpers while withholding Hub secrets', () => {
  const environment = workerEnvironment(
    {
      API_KEY: 'provider',
      DB_URL: 'hub-db',
      JWT_SECRET: 'hub-jwt',
      MCPHUB_WORKERS: 'control-tokens',
      MCPHUB_KEY_POOL_URL: 'http://hub/internal',
      MCPHUB_KEY_POOL_TOKEN: 'pool-only',
      MCP_RELAY_TOKEN: 'relay',
      MCP_USAGE_LOG_DIR: '/logs',
      SLACK_MCP_CHANNELS_CACHE: '/cache/channels',
      PATH: '/toolchain',
      OTHER_PROVIDER: 'another-mcp-key',
    },
    { API_KEY: 'provider' },
  );
  expect(environment).toEqual({
    API_KEY: 'provider',
    MCPHUB_KEY_POOL_URL: 'http://hub/internal',
    MCPHUB_KEY_POOL_TOKEN: 'pool-only',
    MCP_RELAY_TOKEN: 'relay',
    MCP_USAGE_LOG_DIR: '/logs',
    SLACK_MCP_CHANNELS_CACHE: '/cache/channels',
    PATH: '/toolchain',
  });
});

test('different versions of one MCP can be pinned to different target workers', () => {
  process.env.MCPHUB_WORKERS = JSON.stringify({
    atlas: endpoint,
    isolated: { ...endpoint, targets: { notion: ['fixture3'] } },
  });
  expect(runtimeWorkerFor('atlas::notion', 'fixture3')?.id).toBe('isolated');
  expect(runtimeWorkerFor('atlas::notion', 'official')?.id).toBe('atlas');
});

test('database null environment is treated as an empty explicit credential map', () => {
  expect(workerEnvironment({ PATH: '/bin', JWT_SECRET: 'must-not-forward' }, null)).toEqual({
    PATH: '/bin',
  });
});
