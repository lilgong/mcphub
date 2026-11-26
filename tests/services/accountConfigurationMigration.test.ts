import { migrateAccountConfigurations } from '../../src/services/accountConfigurationMigration.js';
import type { ServerConfig, UserGroup } from '../../src/types/index.js';
import type { WorkspaceCredentials } from '../../src/types/workspace.js';

let mockServers: (ServerConfig & { name: string })[] = [];
let mockGroups: UserGroup[] = [];
const mockAccounts = new Map<string, WorkspaceCredentials>();
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({
    findAll: async () => mockServers,
    update: async (name: string, value: Partial<ServerConfig>) => {
      Object.assign(mockServers.find((s) => s.name === name)!, value);
    },
  }),
  getSystemConfigDao: () => ({
    get: async () => ({ userGroups: mockGroups }),
    update: async (value: { userGroups: UserGroup[] }) => {
      mockGroups = value.userGroups;
    },
  }),
}));
jest.mock('../../src/services/workspaceService.js', () => ({
  validWorkspaceName: (s: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(s),
  getWorkspace: async (_catalog: string, name: string) => mockAccounts.get(name),
  saveWorkspace: async (catalog: string, name: string, value: WorkspaceCredentials) => {
    const current = mockAccounts.get(name);
    mockAccounts.set(name, {
      ...value,
      catalog,
      name,
      revision: name,
      serverConnections: { ...current?.serverConnections, ...value.serverConnections },
    });
  },
}));
test('migration preserves executable versions, credentials, ACLs and group grants without prefixed account identifiers', async () => {
  mockAccounts.clear();
  mockServers = [
    {
      name: 'atlas::notion',
      type: 'stdio',
      command: 'base',
      targets: [
        {
          path: 'atlas/official',
          kind: 'static',
          version: 'v1',
          allowedUsers: ['alice'],
          config: { type: 'stdio', command: 'node', args: ['v1.js'], env: { KEY: 'key-a' } },
        },
        {
          path: 'atlas/fixture3',
          kind: 'static',
          version: 'v2',
          config: { type: 'stdio', command: 'node', args: ['v2.js'], env: { KEY: 'key-b' } },
        },
      ],
    },
    { name: 'atlas::arxiv', targets: [{ path: 'task/default', kind: 'task' }] },
  ];
  mockGroups = [
    {
      id: 'group',
      owner: 'alice',
      name: 'Atlas',
      enabled: true,
      members: [],
      servers: [{ name: 'atlas::notion', targets: ['atlas/official'] }],
    } as UserGroup,
  ];
  await migrateAccountConfigurations();
  expect(mockAccounts.get('official')?.serverConnections?.notion).toMatchObject({
    version: 'v1',
    allowedUsers: ['alice'],
    config: { args: ['v1.js'], env: { KEY: 'key-a' } },
  });
  expect(mockServers[0].targets?.map((t) => t.path)).toEqual(['official', 'fixture3']);
  expect(mockServers[0].targets?.[0].config?.env).toEqual({ KEY: '' });
  expect(mockServers[0].workspaceSchema).toMatchObject({ enabled: true, connection: true });
  expect(mockGroups[0].servers[0].targets).toEqual(['official']);
  expect(mockServers[1].targets?.[0].path).toBe('task/default');
  const before = JSON.stringify([...mockAccounts]);
  await migrateAccountConfigurations();
  expect(JSON.stringify([...mockAccounts])).toBe(before);
});
