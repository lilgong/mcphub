import {
  getUserGroupPolicy,
  userGroupAllows,
  migrateOwnedCallGroups,
} from '../../src/services/userGroupService.js';
import type { BearerKey, UserGroup } from '../../src/types/index.js';
const group: UserGroup = {
  id: 'atlas',
  name: 'Atlas',
  owner: 'admin',
  enabled: true,
  servers: [{ name: 'slack', targets: ['atlas/official'] }, { name: 'weather' }],
};
let groups: UserGroup[];
let key: BearerKey | undefined;
let ownerPresent: boolean;
const updateConfig = jest.fn(async (value: { userGroups: UserGroup[] }) => {
  groups = value.userGroups;
});
const updateKey = jest.fn(async (_id: string, value: Partial<BearerKey>) => {
  key = { ...key!, ...value };
});
let definitions: {
  name: string;
  owner: string;
  visibility: string;
  targets?: { path: string; kind: string; allowedUsers?: string[] }[];
}[];
jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: () => ({ get: async () => ({ userGroups: groups }), update: updateConfig }),
  getBearerKeyDao: () => ({
    findById: async () => key,
    findAll: async () => (key ? [key] : []),
    update: updateKey,
  }),
  getUserDao: () => ({
    findAll: async () => [{ username: 'admin', isAdmin: true }],
    findByUsername: async (username: string) =>
      ownerPresent ? { username, isAdmin: username === 'admin' } : null,
  }),
  getServerDao: () => ({ findAll: async () => definitions }),
}));
const callingKey = (): BearerKey => ({
  id: 'group-key',
  name: 'atlas',
  token: 'fixture-original-token',
  owner: 'admin',
  enabled: true,
  kind: 'system',
  accessType: 'all',
  userGroupId: 'atlas',
});
beforeEach(() => {
  groups = [structuredClone(group)];
  key = undefined;
  ownerPresent = true;
  definitions = [
    { name: 'weather', owner: 'admin', visibility: 'public' },
    {
      name: 'slack',
      owner: 'admin',
      visibility: 'public',
      targets: [
        { path: 'atlas/official', kind: 'static' },
        { path: 'atlas/syn-1', kind: 'static' },
      ],
    },
  ];
  jest.clearAllMocks();
});
test('a group key spans its resources but never other groups or targets', async () => {
  key = callingKey();
  groups.push({ ...group, id: 'other', servers: [{ name: 'notion' }] });
  const policy = await getUserGroupPolicy(null, key.id);
  expect(userGroupAllows(policy, 'slack', 'atlas/official')).toBe(true);
  expect(userGroupAllows(policy, 'weather')).toBe(true);
  expect(userGroupAllows(policy, 'notion')).toBe(false);
  expect(userGroupAllows(policy, 'slack', 'atlas/syn-1')).toBe(false);
  groups[0].servers = [];
  expect(userGroupAllows(await getUserGroupPolicy(null, key.id), 'weather')).toBe(false);
});
test('disabled/deleted groups, missing owners, and owner mismatch fail closed', async () => {
  key = callingKey();
  groups[0].enabled = false;
  expect((await getUserGroupPolicy(null, key.id)).groups).toHaveLength(0);
  groups = [];
  expect((await getUserGroupPolicy(null, key.id)).groups).toHaveLength(0);
  groups = [group];
  ownerPresent = false;
  expect((await getUserGroupPolicy(null, key.id)).groups).toHaveLength(0);
  ownerPresent = true;
  key.owner = 'bob';
  expect((await getUserGroupPolicy(null, key.id)).groups).toHaveLength(0);
});
test('an ordinary owner cannot retain another user’s private MCP after sharing is revoked', async () => {
  groups[0].owner = 'alice';
  key = { ...callingKey(), kind: 'user', owner: 'alice' };
  expect(userGroupAllows(await getUserGroupPolicy(null, key.id), 'weather')).toBe(true);
  definitions[0].visibility = 'private';
  expect(userGroupAllows(await getUserGroupPolicy(null, key.id), 'weather')).toBe(false);
  definitions[0].owner = 'alice';
  expect(userGroupAllows(await getUserGroupPolicy(null, key.id), 'weather')).toBe(true);
});
test('removing target access blocks the group key even when the server remains public', async () => {
  groups[0].owner = 'alice';
  key = { ...callingKey(), owner: 'alice', kind: 'user' };
  definitions[1].targets![0].allowedUsers = ['alice'];
  expect(userGroupAllows(await getUserGroupPolicy(null, key.id), 'slack', 'atlas/official')).toBe(
    true,
  );
  definitions[1].targets![0].allowedUsers = ['bob'];
  expect(userGroupAllows(await getUserGroupPolicy(null, key.id), 'slack', 'atlas/official')).toBe(
    false,
  );
});
test('dashboard accounts are governed by visibility; only the presented key selects a group', async () => {
  expect((await getUserGroupPolicy({ username: 'alice' })).restricted).toBe(false);
  key = { ...callingKey(), userGroupId: undefined, owner: undefined };
  expect((await getUserGroupPolicy({ username: 'alice' }, key.id)).restricted).toBe(false);
  key.userGroupId = 'atlas';
  key.owner = 'admin';
  expect((await getUserGroupPolicy({ username: 'alice' }, key.id)).groups).toHaveLength(0);
});
test('missing/disabled keys cannot regain unbound shared access', async () => {
  expect((await getUserGroupPolicy(null, 'deleted')).restricted).toBe(true);
  key = callingKey();
  key.enabled = false;
  expect((await getUserGroupPolicy(null, key.id)).groups).toHaveLength(0);
});
test('omitted target grants and empty grants retain their existing meanings', () => {
  const policy = { restricted: true, groups: [group] };
  expect(userGroupAllows(policy, 'weather', 'any/default')).toBe(true);
  policy.groups = [{ ...group, servers: [{ name: 'weather', targets: [] }] }];
  expect(userGroupAllows(policy, 'weather', 'any/default')).toBe(false);
});
test('migration preserves tokens, ids, grants and kinds and runs only once', async () => {
  groups = [{ ...group, owner: undefined, members: ['alice'] } as unknown as UserGroup];
  key = { ...callingKey(), owner: undefined };
  const before = structuredClone(key);
  await migrateOwnedCallGroups();
  expect(groups[0]).toEqual(group);
  expect(key).toEqual({ ...before, owner: 'admin' });
  expect(updateConfig).toHaveBeenCalledTimes(1);
  expect(updateKey).toHaveBeenCalledTimes(1);
  await migrateOwnedCallGroups();
  expect(updateConfig).toHaveBeenCalledTimes(1);
  expect(updateKey).toHaveBeenCalledTimes(1);
});
