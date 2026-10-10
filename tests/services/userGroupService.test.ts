import { getUserGroupPolicy, userGroupAllows } from '../../src/services/userGroupService.js';
import type { BearerKey, UserGroup } from '../../src/types/index.js';
const group: UserGroup = {
  id: 'atlas',
  name: 'Atlas',
  enabled: true,
  members: ['alice'],
  servers: [{ name: 'slack', targets: ['atlas/official'] }, { name: 'weather' }],
};
let groups: UserGroup[] = [];
let key: BearerKey | undefined;
jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: () => ({ get: async () => ({ userGroups: groups }) }),
  getBearerKeyDao: () => ({ findById: async () => key }),
}));
beforeEach(() => {
  groups = [structuredClone(group)];
  key = undefined;
});
test('one group key authorizes multiple MCPs while checking the explicit target', async () => {
  key = {
    id: 'group-key',
    name: 'atlas',
    token: 'test',
    enabled: true,
    kind: 'system',
    accessType: 'all',
    userGroupId: 'atlas',
  };
  const policy = await getUserGroupPolicy(null, key.id);
  expect(userGroupAllows(policy, 'slack', 'atlas/official')).toBe(true);
  expect(userGroupAllows(policy, 'weather')).toBe(true);
  expect(userGroupAllows(policy, 'notion', 'atlas/official')).toBe(false);
  expect(userGroupAllows(policy, 'slack', 'atlas/syn-1')).toBe(false);
  groups[0].servers = [];
  expect(userGroupAllows(await getUserGroupPolicy(null, key.id), 'slack', 'atlas/official')).toBe(
    false,
  );
});
test('disabled or deleted groups and disabled group keys fail closed', async () => {
  key = {
    id: 'k',
    name: 'k',
    token: 'test',
    enabled: true,
    kind: 'system',
    accessType: 'all',
    userGroupId: 'atlas',
  };
  groups[0].enabled = false;
  expect(userGroupAllows(await getUserGroupPolicy(null, 'k'), 'weather')).toBe(false);
  groups = [];
  expect(userGroupAllows(await getUserGroupPolicy(null, 'k'), 'weather')).toBe(false);
  groups = [group];
  key.enabled = false;
  expect(userGroupAllows(await getUserGroupPolicy(null, 'k'), 'weather')).toBe(false);
});
test('member groups combine permissions without giving access to other targets', async () => {
  groups.push({ ...group, id: 'other', servers: [{ name: 'notion', targets: ['atlas/syn-1'] }] });
  const policy = await getUserGroupPolicy({ username: 'alice' });
  expect(userGroupAllows(policy, 'slack', 'atlas/official')).toBe(true);
  expect(userGroupAllows(policy, 'notion', 'atlas/syn-1')).toBe(true);
  expect(userGroupAllows(policy, 'notion', 'atlas/official')).toBe(false);
  expect((await getUserGroupPolicy({ username: 'bob' })).restricted).toBe(false);
});
test('shared keys have no group restriction, while a group key does not inherit member groups', async () => {
  key = {
    id: 'k',
    name: 'shared',
    token: 'test',
    enabled: true,
    kind: 'system',
    accessType: 'all',
  };
  expect(userGroupAllows(await getUserGroupPolicy({ username: 'alice' }, 'k'), 'other')).toBe(true);
  key.userGroupId = 'atlas';
  groups.push({ ...group, id: 'other', servers: [{ name: 'other' }] });
  expect(userGroupAllows(await getUserGroupPolicy({ username: 'alice' }, 'k'), 'other')).toBe(
    false,
  );
});
test('an omitted target limit permits all targets; an empty limit permits none', async () => {
  const policy = { restricted: true, groups: [group] };
  expect(userGroupAllows(policy, 'weather', 'anything/default')).toBe(true);
  policy.groups = [{ ...group, servers: [{ name: 'weather', targets: [] }] }];
  expect(userGroupAllows(policy, 'weather', 'anything/default')).toBe(false);
});

test('deleted calling keys cannot regain shared access through an existing context', async () => {
  expect(
    userGroupAllows(
      await getUserGroupPolicy({ username: 'system', isAdmin: true }, 'deleted'),
      'weather',
    ),
  ).toBe(false);
});
