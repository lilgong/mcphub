import type { Request, Response } from 'express';
import {
  getUserGroups,
  getGroupResources,
  saveUserGroup,
} from '../../src/controllers/userGroupController.js';
import type { UserGroup } from '../../src/types/index.js';
let groups: UserGroup[];
const users = [
  { username: 'admin', isAdmin: true },
  { username: 'alice', isAdmin: false },
  { username: 'bob', isAdmin: false },
];
const definitions = [
  {
    name: 'bob-only-targets',
    owner: 'admin',
    visibility: 'public',
    targets: [{ path: 'suite/bob', kind: 'static', allowedUsers: ['bob'] }],
  },
  { name: 'public', owner: 'admin', visibility: 'public' },
  { name: 'alice-private', owner: 'alice', visibility: 'private' },
  {
    name: 'bob-private',
    owner: 'bob',
    visibility: 'private',
    headers: { Authorization: 'never-expose' },
  },
  {
    name: 'targets',
    owner: 'admin',
    visibility: 'public',
    targets: [
      {
        path: 'suite/alice',
        kind: 'static',
        allowedUsers: ['alice'],
        config: { headers: { KEY: 'never-expose' } },
      },
      { path: 'suite/bob', kind: 'static', allowedUsers: ['bob'] },
    ],
  },
];
const update = jest.fn(async (value: { userGroups: UserGroup[] }) => {
  groups = structuredClone(value.userGroups);
});
jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: () => ({
    get: async () => ({ userGroups: structuredClone(groups) }),
    update,
  }),
  getUserDao: () => ({
    findByUsername: async (name: string) => users.find((user) => user.username === name),
  }),
  getServerDao: () => ({ findAll: async () => definitions }),
}));
const req = (
  body: unknown = {},
  username = 'alice',
  id?: string,
  method = 'POST',
  query = {},
): Request =>
  ({
    body,
    params: { id },
    method,
    query,
    user: users.find((user) => user.username === username),
  }) as unknown as Request;
const res = (): Response => {
  const value = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return value as unknown as Response;
};
beforeEach(() => {
  groups = [
    { id: 'a', owner: 'alice', name: 'Search', enabled: true, servers: [{ name: 'public' }] },
    { id: 'b', owner: 'bob', name: 'Search', enabled: true, servers: [] },
  ];
  update.mockClear();
});
test('ordinary users see only their groups; administrators see all owners', async () => {
  const alice = res();
  await getUserGroups(req(), alice);
  expect(alice.json).toHaveBeenCalledWith({ success: true, data: [groups[0]] });
  const admin = res();
  await getUserGroups(req({}, 'admin'), admin);
  expect(admin.json).toHaveBeenCalledWith({ success: true, data: groups });
});
test('resource selector exposes only allowed names and target paths, never configs', async () => {
  const response = res();
  await getGroupResources(req(), response);
  const data = (response.json as jest.Mock).mock.calls[0][0].data;
  expect(data.map((server: { name: string }) => server.name)).toEqual([
    'public',
    'alice-private',
    'targets',
  ]);
  expect(data[2].targets.map((target: { path: string }) => target.path)).toEqual(['suite/alice']);
  expect(JSON.stringify(data)).not.toContain('never-expose');
  const denied = res();
  await getGroupResources(req({}, 'alice', undefined, 'GET', { owner: 'bob' }), denied);
  expect(denied.status).toHaveBeenCalledWith(403);
});
test('an owner can create several groups and another owner can reuse a group name', async () => {
  const response = res();
  await saveUserGroup(
    req({ name: 'Other', enabled: true, servers: [{ name: 'public' }, { name: 'alice-private' }] }),
    response,
  );
  expect(response.status).toHaveBeenCalledWith(201);
  expect(groups[2].owner).toBe('alice');
  const same = res();
  await saveUserGroup(req({ name: 'Other', enabled: true, servers: [] }, 'bob'), same);
  expect(same.status).toHaveBeenCalledWith(201);
});
test('ordinary users cannot manage another owner or grant private/forbidden targets', async () => {
  for (const body of [
    { name: 'Private', enabled: true, owner: 'bob', servers: [] },
    { name: 'Private', enabled: true, servers: [{ name: 'bob-private' }] },
    { name: 'Targets', enabled: true, servers: [{ name: 'targets', targets: ['suite/bob'] }] },
  ]) {
    const response = res();
    await saveUserGroup(req(body), response);
    expect(response.status).toHaveBeenCalledWith(400);
  }
  const updateOther = res();
  await saveUserGroup(
    req({ name: 'Renamed', enabled: true, servers: [] }, 'alice', 'b', 'PUT'),
    updateOther,
  );
  expect(updateOther.status).toHaveBeenCalledWith(404);
  const deleteOther = res();
  await saveUserGroup(req({}, 'alice', 'b', 'DELETE'), deleteOther);
  expect(deleteOther.status).toHaveBeenCalledWith(404);
});
test('admins creating groups for ordinary owners cannot bypass those owners’ ACLs', async () => {
  const response = res();
  await saveUserGroup(
    req(
      { owner: 'alice', name: 'Private', enabled: true, servers: [{ name: 'bob-private' }] },
      'admin',
    ),
    response,
  );
  expect(response.status).toHaveBeenCalledWith(400);
});
test('deleting a group preserves other owners and requires no user membership', async () => {
  const response = res();
  await saveUserGroup(req({}, 'alice', 'a', 'DELETE'), response);
  expect(groups.map((group) => group.id)).toEqual(['b']);
});
test('concurrent group creation preserves both owners’ updates', async () => {
  await Promise.all(
    ['alice', 'bob'].map((owner) =>
      saveUserGroup(req({ name: 'New', enabled: true, servers: [] }, owner), res()),
    ),
  );
  expect(groups.filter((group) => group.name === 'New')).toHaveLength(2);
});
