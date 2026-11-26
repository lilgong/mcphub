import { workspaceDefinition } from '../../src/services/workspaceRuntimeService.js';
import { TargetRuntimeService } from '../../src/services/targetRuntimeService.js';
import type { ServerConfig, ServerInfo } from '../../src/types/index.js';
import type { WorkspaceCredentials } from '../../src/types/workspace.js';

const mockAccounts = new Map<string, WorkspaceCredentials>();
let mockAllowed = true;
jest.mock('../../src/services/workspaceService.js', () => ({
  getWorkspace: async (_catalog: string, name: string) => mockAccounts.get(name),
}));
jest.mock('../../src/services/userGroupService.js', () => ({
  getUserGroupPolicy: async (_user: unknown, key?: string) => ({
    restricted: !!key,
    groups: mockAllowed ? [{ id: 'group-a' }] : [],
  }),
  userGroupAllows: () => mockAllowed,
}));
jest.mock('../../src/services/serverConfigEnvironment.js', () => ({
  expandServerConfig: async (v: unknown) => v,
}));
const definition: ServerConfig = {
  type: 'stdio',
  command: 'shared-must-not-run',
  env: { KEY: 'shared-must-not-leak' },
  workspaceSchema: { enabled: true, connection: true },
  targets: [
    { path: 'account-a', kind: 'static', config: { type: 'stdio', command: 'metadata-only' } },
  ],
};
const user = { username: 'benchmark', isAdmin: true };
beforeEach(() => {
  mockAllowed = true;
  mockAccounts.clear();
  for (const name of ['account-a', 'account-b'])
    mockAccounts.set(name, {
      catalog: 'example',
      name,
      revision: name,
      allowedGroupIds: ['group-a'],
      values: {},
      files: {},
      serverConnections: {
        search: {
          config: {
            type: 'stdio',
            command: 'node',
            args: [`/${name}/v${name.endsWith('a') ? 1 : 2}.cjs`],
            env: { KEY: name },
          },
        },
      },
    });
});
test('one account identifier selects both version and credentials without modifying the shared config', async () => {
  for (const account of ['account-a', 'account-b']) {
    const result = await workspaceDefinition('example::search', definition, account, user, 'key');
    expect(result?.targets?.[0].config?.env).toEqual({ KEY: account });
    expect(result?.targets?.[0].config?.args?.[0]).toContain(account);
  }
  expect(definition.env).toEqual({ KEY: 'shared-must-not-leak' });
});
test('missing, unknown, disabled and forbidden accounts do not fall back to shared credentials', async () => {
  for (const account of [undefined, 'missing', 'example/account-a'])
    await expect(
      workspaceDefinition('example::search', definition, account, user, 'key'),
    ).rejects.toThrow();
  mockAllowed = false;
  await expect(
    workspaceDefinition('example::search', definition, 'account-a', user, 'key'),
  ).rejects.toThrow();
});
test('single connections and task callbacks retain their independent behavior', async () => {
  expect(
    await workspaceDefinition(
      'example::search',
      {
        ...definition,
        targets: [],
        workspaceSchema: { enabled: false, connection: true },
      },
      'account-a',
      user,
    ),
  ).toBeUndefined();
  expect(
    await workspaceDefinition(
      'example::search',
      {
        ...definition,
        targets: [{ path: 'task/default', kind: 'task' }],
      },
      undefined,
      user,
    ),
  ).toBeUndefined();
});
test('declared account fields override the environment and missing keys fail closed', async () => {
  const mapped = {
    ...definition,
    workspaceSchema: {
      enabled: true,
      connection: true,
      values: [{ name: 'api_key', env: 'KEY' }],
    },
  };
  await expect(workspaceDefinition('example::search', mapped, 'account-a', user)).rejects.toThrow();
  mockAccounts.get('account-a')!.values.api_key = 'rotated';
  expect(
    (await workspaceDefinition('example::search', mapped, 'account-a', user))?.targets?.[0].config
      ?.env?.KEY,
  ).toBe('rotated');
});
test('resident clients stay isolated across accounts and restart only the changed configuration', async () => {
  const connect = jest.fn(
    async (_name: string, config: ServerConfig) =>
      ({
        name: 'example::search',
        status: 'connected',
        tools: [],
        prompts: [],
        resources: [],
        error: null,
        createTime: Date.now(),
        config,
      }) as ServerInfo,
  );
  const pool = new TargetRuntimeService(connect, jest.fn(), async () => definition);
  const a = await pool.acquire('example::search', definition, 'account-a', user, 'key');
  const b = await pool.acquire('example::search', definition, 'account-b', user, 'key');
  expect(a.info).not.toBe(b.info);
  mockAccounts.get('account-a')!.serverConnections!.search.config!.env!.KEY = 'updated';
  const changed = await pool.acquire('example::search', definition, 'account-a', user, 'key');
  const same = await pool.acquire('example::search', definition, 'account-b', user, 'key');
  expect(changed.info).not.toBe(a.info);
  expect(same.info).toBe(b.info);
  a.release();
  b.release();
  changed.release();
  same.release();
  pool.invalidate();
});
