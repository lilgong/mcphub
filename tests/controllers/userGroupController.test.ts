import type { Request, Response } from 'express';
import { moveUserGroupMember, saveUserGroup } from '../../src/controllers/userGroupController.js';
import type { UserGroup } from '../../src/types/index.js';
import { userGroupAllows } from '../../src/services/userGroupService.js';

let groups: UserGroup[];
const snapshots: UserGroup[][] = [];
const update = jest.fn(async (value: { userGroups: UserGroup[] }) => {
  groups = structuredClone(value.userGroups);
  snapshots.push(structuredClone(groups));
});
jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: () => ({
    get: async () => ({ userGroups: structuredClone(groups) }),
    update,
  }),
  getUserDao: () => ({ findAll: async () => [{ username: 'alice' }, { username: 'bob' }] }),
  getServerDao: () => ({
    findAll: async () => [
      { name: 'slack', targets: [{ path: 'atlas/official' }, { path: 'atlas/syn-1' }] },
    ],
  }),
}));
function request(body: unknown, admin = true, id?: string): Request {
  return { body, user: { isAdmin: admin }, params: { id }, method: 'PUT' } as unknown as Request;
}
function response(): Response {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}
beforeEach(() => {
  groups = [
    {
      id: 'a',
      name: 'A',
      enabled: true,
      members: ['alice', 'bob'],
      servers: [{ name: 'slack', targets: ['atlas/official'] }],
    },
    {
      id: 'b',
      name: 'B',
      enabled: true,
      members: [],
      servers: [{ name: 'slack', targets: ['atlas/syn-1'] }],
    },
  ];
  snapshots.length = 0;
  update.mockClear();
});
test('moving a user changes permissions with one atomic configuration write', async () => {
  const res = response();
  await moveUserGroupMember(request({ username: 'alice', groupId: 'b' }), res);
  expect(update).toHaveBeenCalledTimes(1);
  expect(groups[0].members).toEqual(['bob']);
  expect(groups[1].members).toEqual(['alice']);
  const policy = {
    restricted: true,
    groups: groups.filter((group) => group.members.includes('alice')),
  };
  expect(userGroupAllows(policy, 'slack', 'atlas/official')).toBe(false);
  expect(userGroupAllows(policy, 'slack', 'atlas/syn-1')).toBe(true);
  expect(
    snapshots.every((snapshot) => snapshot.some((group) => group.members.includes('alice'))),
  ).toBe(true);
});
test('concurrent moves do not overwrite another user membership', async () => {
  await Promise.all([
    moveUserGroupMember(request({ username: 'alice', groupId: 'b' }), response()),
    moveUserGroupMember(request({ username: 'bob', groupId: 'b' }), response()),
  ]);
  expect(groups[0].members).toEqual([]);
  expect(groups[1].members).toEqual(['alice', 'bob']);
});
test('moving and renaming share the same mutation queue', async () => {
  const first = moveUserGroupMember(request({ username: 'alice', groupId: 'b' }), response());
  // Rename the source group with its remaining member, preserving both operations.
  const second = saveUserGroup(
    request({ ...groups[0], name: 'Renamed', members: ['bob'] }, true, 'a'),
    response(),
  );
  await Promise.all([first, second]);
  expect(groups[0].name).toBe('Renamed');
  expect(groups[1].members).toEqual(['alice']);
});
test('moving to ungrouped clears all memberships without changing resources', async () => {
  groups[1].members = ['alice'];
  await moveUserGroupMember(request({ username: 'alice', groupId: null }), response());
  expect(groups.every((group) => !group.members.includes('alice'))).toBe(true);
  expect(groups[0].servers[0].targets).toEqual(['atlas/official']);
});
test.each([
  { username: 'unknown', groupId: 'b' },
  { username: 'alice', groupId: 'missing' },
  { username: 'alice' },
  { username: 'alice', groupId: 5 },
])('invalid move fails without changing permissions: %p', async (body) => {
  const res = response();
  await moveUserGroupMember(request(body), res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(update).not.toHaveBeenCalled();
});
test('membership management requires administrator access', async () => {
  const res = response();
  await moveUserGroupMember(request({ username: 'alice', groupId: 'b' }, false), res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(update).not.toHaveBeenCalled();
});
