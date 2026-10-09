import { TargetRuntimeService } from '../../src/services/targetRuntimeService.js';
import { normalizeTargetConnections } from '../../src/utils/targetConnection.js';
import type { ServerInfo, ServerConfig } from '../../src/types/index.js';
jest.mock('../../src/services/serverConfigEnvironment.js', () => ({
  expandServerConfig: async (value: unknown) => value,
}));
const definition: ServerConfig = {
  type: 'stdio',
  command: 'base-never-run',
  passthroughHeaders: ['Authorization'],
  oauth: { accessToken: 'parent-never-used' },
  env: { KEY: 'base-never-used' },
  targets: [
    {
      path: 'other/official',
      kind: 'static',
      allowedKeyIds: ['key-a'],
      config: { type: 'stdio', command: 'provider', env: { KEY: 'workspace-a' } },
    },
    {
      path: 'other/syn-1',
      kind: 'static',
      allowedKeyIds: ['key-b'],
      config: {
        type: 'streamable-http',
        url: 'https://example.org/mcp',
        headers: { Authorization: 'workspace-b' },
      },
    },
  ],
};
const principal = { username: 'benchmark', isAdmin: true };
const child = (config: ServerConfig): ServerInfo => ({
  name: 'notion',
  status: 'connected',
  tools: [],
  prompts: [],
  resources: [],
  error: null,
  createTime: Date.now(),
  config,
});
test('missing, unknown and cross-target credentials fail before spawning, including administrators', async () => {
  const connect = jest.fn(async (_name, config) => child(config));
  const pool = new TargetRuntimeService(connect, jest.fn());
  for (const path of [undefined, 'other/missing', 'other/syn-1'])
    await expect(pool.acquire('notion', definition, path, principal, 'key-a')).rejects.toThrow();
  expect(connect).not.toHaveBeenCalled();
});
test('parallel creation coalesces per target, credentials never inherit or cross targets, edits replace children', async () => {
  const connect = jest.fn(async (_name, config) => child(config));
  const close = jest.fn();
  const pool = new TargetRuntimeService(connect, close);
  const [a, same, b] = await Promise.all([
    pool.acquire('notion', definition, 'other/official', principal, 'key-a'),
    pool.acquire('notion', definition, 'other/official', principal, 'key-a'),
    pool.acquire('notion', definition, 'other/syn-1', principal, 'key-b'),
  ]);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(a.info).toBe(same.info);
  expect(a.info).not.toBe(b.info);
  expect(a.info.config?.env?.KEY).toBe('workspace-a');
  expect(b.info.config?.env?.KEY).toBeUndefined();
  expect(b.info.config?.command).toBeUndefined();
  expect(a.info.config?.passthroughHeaders).toBeUndefined();
  expect(b.info.config?.oauth).toBeUndefined();
  expect(a.info.config?.url).toBeUndefined();
  const edited = structuredClone(definition);
  edited.targets![0].config!.env = { KEY: 'rotated' };
  const next = await pool.acquire('notion', edited, 'other/official', principal, 'key-a');
  expect(next.info).not.toBe(a.info);
  expect(next.info.config?.env?.KEY).toBe('rotated');
  a.release();
  same.release();
  a.release();
  b.release();
  next.release();
  pool.invalidate();
  await new Promise((resolve) => setImmediate(resolve));
  expect(close).toHaveBeenCalledWith(a.info);
});
test('target definitions reject ambiguous paths, duplicates and missing explicit transport destinations', () => {
  for (const targets of [
    [{ path: 'other/../b', kind: 'task' }],
    [{ path: 'other/a', kind: 'static', config: {} }],
    [
      { path: 'other/a', kind: 'task' },
      { path: 'other/a', kind: 'task' },
    ],
  ])
    expect(() => normalizeTargetConnections(targets)).toThrow();
  expect(normalizeTargetConnections([{ path: 'benchmark/suite-2', kind: 'task' }])?.[0].path).toBe(
    'benchmark/suite-2',
  );
});

test('live persisted definitions take precedence over stale runtime snapshots after credential edits or deletion', async () => {
  let current: ServerConfig | undefined = structuredClone(definition);
  current.targets![0].config!.env = { KEY: 'live-updated-key' };
  const connect = jest.fn(async (_name, config) => child(config));
  const pool = new TargetRuntimeService(connect, jest.fn(), async () => current);
  const lease = await pool.acquire('notion', definition, 'other/official', principal, 'key-a');
  expect(lease.info.config?.env?.KEY).toBe('live-updated-key');
  lease.release();
  current = undefined;
  await expect(
    pool.acquire('notion', definition, 'other/official', principal, 'key-a'),
  ).rejects.toThrow('unavailable');
  pool.invalidate();
});
