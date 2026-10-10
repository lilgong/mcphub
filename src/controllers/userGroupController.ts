import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { UserGroup } from '../types/index.js';
import { getServerDao, getSystemConfigDao, getUserDao } from '../dao/index.js';
import { requireAdmin } from '../utils/requireAdmin.js';
import { validateTargetPath } from '../utils/targetConnection.js';

export async function getUserGroups(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  res.json({ success: true, data: (await getSystemConfigDao().get()).userGroups ?? [] });
}

// Serialize read/modify/write operations in the single Hub process.
let mutations: Promise<unknown> = Promise.resolve();
/** Move a user atomically so a folder move cannot temporarily drop all restrictions. */
export async function moveUserGroupMember(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  const operation = mutations
    .catch(() => undefined)
    .then(async () => {
      const { username, groupId } = req.body;
      if (typeof username !== 'string' || (groupId !== null && typeof groupId !== 'string'))
        throw new Error('Invalid membership move');
      if (!(await getUserDao().findAll()).some((user) => user.username === username))
        throw new Error('Unknown group member');
      const groups = (await getSystemConfigDao().get()).userGroups ?? [];
      if (groupId !== null && !groups.some((group) => group.id === groupId))
        throw new Error('User group not found');
      const updated = groups.map((group) => ({
        ...group,
        members:
          group.id === groupId
            ? [...new Set([...group.members, username])]
            : group.members.filter((name) => name !== username),
      }));
      await getSystemConfigDao().update({ userGroups: updated });
      res.json({ success: true, data: updated });
    });
  mutations = operation;
  try {
    await operation;
  } catch (error) {
    res
      .status(400)
      .json({
        success: false,
        message: error instanceof Error ? error.message : 'Invalid membership move',
      });
  }
}

export async function saveUserGroup(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  const operation = mutations
    .catch(() => undefined)
    .then(async () => {
      const config = await getSystemConfigDao().get();
      const groups = config.userGroups ?? [];
      const id = req.params.id;
      const existing = id ? groups.find((group) => group.id === id) : undefined;
      if (id && !existing) {
        res.status(404).json({ success: false, message: 'User group not found' });
        return;
      }
      if (req.method === 'DELETE') {
        // Bound keys retain the deleted ID and fail closed; they never become shared keys.
        await getSystemConfigDao().update({
          userGroups: groups.filter((group) => group.id !== id),
        });
        res.json({ success: true });
        return;
      }
      const { name, description, enabled, members, servers } = req.body;
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 100 ||
        (description !== undefined &&
          (typeof description !== 'string' || description.length > 1000)) ||
        typeof enabled !== 'boolean' ||
        !Array.isArray(members) ||
        !Array.isArray(servers) ||
        members.length > 1000 ||
        servers.length > 1000 ||
        groups.some((group) => group.id !== id && group.name === name.trim())
      )
        throw new Error('Invalid user group');
      const users = await getUserDao().findAll();
      if (
        members.some(
          (username: unknown) =>
            typeof username !== 'string' || !users.some((user) => user.username === username),
        )
      )
        throw new Error('Unknown group member');
      const registered = await getServerDao().findAll();
      const seen = new Set<string>();
      for (const resource of servers) {
        const server = registered.find((entry) => entry.name === resource?.name);
        if (!server || seen.has(resource.name)) throw new Error('Unknown or duplicate MCP');
        seen.add(resource.name);
        if (
          resource.targets !== undefined &&
          (!Array.isArray(resource.targets) ||
            resource.targets.length > 1000 ||
            resource.targets.some(
              (path: unknown) =>
                !validateTargetPath(path) ||
                !server.targets?.some((target) => target.path === path),
            ))
        )
          throw new Error('Unknown target');
      }
      const group: UserGroup = {
        id: existing?.id ?? randomUUID(),
        name: name.trim(),
        description,
        enabled,
        members: [...new Set<string>(members)],
        servers: servers.map((resource) => ({
          name: resource.name,
          ...(resource.targets !== undefined
            ? { targets: [...new Set<string>(resource.targets)] }
            : {}),
        })),
      };
      if (!id && groups.length >= 1000) throw new Error('Too many user groups');
      await getSystemConfigDao().update({
        userGroups: existing
          ? groups.map((entry) => (entry.id === id ? group : entry))
          : [...groups, group],
      });
      res.status(existing ? 200 : 201).json({ success: true, data: group });
    });
  mutations = operation;
  try {
    await operation;
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error instanceof Error ? error.message : 'Invalid user group',
    });
  }
}
