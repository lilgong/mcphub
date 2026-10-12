import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { UserGroup, IUser } from '../types/index.js';
import { getServerDao, getSystemConfigDao, getUserDao } from '../dao/index.js';
import { authorizationService } from '../services/authorizationService.js';
import { canSelectGroupTarget } from '../services/userGroupService.js';
import { validateTargetPath } from '../utils/targetConnection.js';

const caller = (req: Request): IUser | undefined => (req as Request & { user?: IUser }).user;
export async function getUserGroups(req: Request, res: Response): Promise<void> {
  const user = caller(req);
  if (!user?.username) {
    res.status(401).json({ success: false });
    return;
  }
  const groups = (await getSystemConfigDao().get()).userGroups ?? [];
  res.json({
    success: true,
    data: groups.filter((group) => user.isAdmin || group.owner === user.username),
  });
}

/** Safe selector metadata for the prospective group owner, without config or runtime leases. */
export async function getGroupResources(req: Request, res: Response): Promise<void> {
  const user = caller(req);
  if (!user?.username) {
    res.status(401).json({ success: false });
    return;
  }
  const requested = typeof req.query.owner === 'string' ? req.query.owner : user.username;
  if (!user.isAdmin && requested !== user.username) {
    res.status(403).json({ success: false });
    return;
  }
  const owner = await getUserDao().findByUsername(requested);
  if (!owner) {
    res.status(404).json({ success: false });
    return;
  }
  const definitions = await getServerDao().findAll();
  res.json({
    success: true,
    data: definitions
      .filter((server) => authorizationService.can('server.invoke', server, owner))
      .filter(
        (server) =>
          !server.targets?.length ||
          server.targets.some((target) => canSelectGroupTarget(server, target, owner)),
      )
      .map((server) => ({
        name: server.name,
        enabled: server.enabled !== false,
        targets: (server.targets ?? [])
          .filter((target) => canSelectGroupTarget(server, target, owner))
          .map((target) => ({
            path: target.path,
            enabled: target.enabled !== false,
            kind: target.kind,
          })),
      })),
  });
}

let mutations: Promise<unknown> = Promise.resolve();
export async function saveUserGroup(req: Request, res: Response): Promise<void> {
  const user = caller(req);
  if (!user?.username) {
    res.status(401).json({ success: false });
    return;
  }
  const operation = mutations
    .catch(() => undefined)
    .then(async () => {
      const config = await getSystemConfigDao().get();
      const groups = config.userGroups ?? [];
      const id = req.params.id;
      const existing = id ? groups.find((group) => group.id === id) : undefined;
      if (id && (!existing || (!user.isAdmin && existing.owner !== user.username))) {
        res.status(404).json({ success: false, message: 'Group not found' });
        return;
      }
      if (req.method === 'DELETE') {
        await getSystemConfigDao().update({
          userGroups: groups.filter((group) => group.id !== id),
        });
        res.json({ success: true });
        return;
      }
      const { name, description, enabled, servers } = req.body;
      const ownerName =
        existing?.owner ?? (user.isAdmin ? req.body.owner || user.username : user.username);
      if ((req.body.owner !== undefined && req.body.owner !== ownerName) || 'members' in req.body)
        throw new Error('Group ownership is fixed; user memberships are not supported');
      const owner = await getUserDao().findByUsername(ownerName);
      if (!owner) throw new Error('Unknown group owner');
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 100 ||
        (description !== undefined &&
          (typeof description !== 'string' || description.length > 1000)) ||
        typeof enabled !== 'boolean' ||
        !Array.isArray(servers) ||
        servers.length > 1000 ||
        groups.some(
          (group) => group.id !== id && group.owner === ownerName && group.name === name.trim(),
        )
      )
        throw new Error('Invalid or duplicate group');
      const registered = await getServerDao().findAll();
      const seen = new Set<string>();
      for (const resource of servers) {
        const server = registered.find((entry) => entry.name === resource?.name);
        if (
          !server ||
          seen.has(resource.name) ||
          !authorizationService.can('server.invoke', server, owner)
        )
          throw new Error('MCP unavailable to group owner');
        seen.add(resource.name);
        if (
          resource.targets !== undefined &&
          (!Array.isArray(resource.targets) ||
            resource.targets.length > 1000 ||
            resource.targets.some(
              (path: unknown) =>
                !validateTargetPath(path) ||
                !server.targets?.some(
                  (target) => target.path === path && canSelectGroupTarget(server, target, owner),
                ),
            ))
        )
          throw new Error('Target unavailable to group owner');
        if (!owner.isAdmin && server.targets?.length && resource.targets === undefined)
          throw new Error('Select explicit targets for this MCP');
      }
      const group: UserGroup = {
        id: existing?.id ?? randomUUID(),
        owner: ownerName,
        name: name.trim(),
        description,
        enabled,
        servers: servers.map((resource) => ({
          name: resource.name,
          ...(resource.targets !== undefined
            ? { targets: [...new Set<string>(resource.targets)] }
            : {}),
        })),
      };
      if (!id && groups.length >= 1000) throw new Error('Too many groups');
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
    res
      .status(400)
      .json({ success: false, message: error instanceof Error ? error.message : 'Invalid group' });
  }
}
