import type {
  BearerKey,
  UserGroup,
  UserGroupResource,
  IUser,
  ServerConfig,
} from '../types/index.js';
import type { RequestPrincipal } from './authorizationService.js';
import { authorizationService } from './authorizationService.js';
import { getBearerKeyDao, getSystemConfigDao, getUserDao, getServerDao } from '../dao/index.js';
import { RequestContextService } from './requestContextService.js';
import { UserContextService } from './userContextService.js';
import type { TargetConnection } from '../types/targetConnection.js';

export interface UserGroupPolicy {
  restricted: boolean;
  groups: UserGroup[];
}

export function canSelectGroupTarget(
  server: ServerConfig,
  target: TargetConnection,
  user: RequestPrincipal,
  keyId?: string,
): boolean {
  if (!authorizationService.can('server.invoke', server, user)) return false;
  if (user.isAdmin || server.owner === user.username) return true;
  if (target.allowedKeyIds?.length || target.allowedUsers?.length)
    return !!(
      target.allowedUsers?.includes(user.username) ||
      (keyId && target.allowedKeyIds?.includes(keyId))
    );
  return true;
}

/** Owner ACLs are rechecked on each invocation; a saved group never grants ownership. */
export async function getUserGroupPolicy(
  principal: RequestPrincipal | null = UserContextService.getInstance().getCurrentUser(),
  keyId = RequestContextService.getInstance().getBearerKeyContext().keyId,
): Promise<UserGroupPolicy> {
  if (!keyId) return { restricted: false, groups: [] };
  const key: BearerKey | undefined = await getBearerKeyDao()?.findById?.(keyId);
  if (!key?.enabled) return { restricted: true, groups: [] };
  if (!key.userGroupId) return { restricted: false, groups: [] };
  const config = await getSystemConfigDao().get();
  const group = config?.userGroups?.find((entry) => entry.id === key.userGroupId && entry.enabled);
  if (!group?.owner || key.owner !== group.owner) return { restricted: true, groups: [] };
  const owner = await getUserDao().findByUsername(group.owner);
  if (!owner || (principal && principal.username !== owner.username))
    return { restricted: true, groups: [] };
  // Existing administrator groups retain their exact original grants.
  if (owner.isAdmin) return { restricted: true, groups: [group] };
  const definitions = await getServerDao().findAll();
  const servers: UserGroupResource[] = group.servers.flatMap((resource) => {
    const server = definitions.find((entry) => entry.name === resource.name);
    if (!server || !authorizationService.can('server.invoke', server, owner)) return [];
    if (!server.targets?.length) return [resource];
    const targets = server.targets
      .filter(
        (target) =>
          target.enabled !== false &&
          canSelectGroupTarget(server, target, owner, key.id) &&
          (resource.targets === undefined || resource.targets.includes(target.path)),
      )
      .map((target) => target.path);
    return [{ name: resource.name, targets }];
  });
  return { restricted: true, groups: [{ ...group, servers }] };
}

export function userGroupAllows(policy: UserGroupPolicy, server: string, target?: string): boolean {
  if (!policy.restricted) return true;
  return policy.groups.some((group) =>
    group.servers.some(
      (resource) =>
        resource.name === server &&
        (target === undefined ||
          resource.targets === undefined ||
          resource.targets.includes(target)),
    ),
  );
}

/** Startup-only, idempotent migration: preserve ids, tokens, grants, enable flags and key kinds. */
export async function migrateOwnedCallGroups(): Promise<void> {
  const dao = getSystemConfigDao();
  const config = await dao.get();
  const original = config?.userGroups ?? [];
  const users = original.some((group) => !group.owner) ? await getUserDao().findAll() : [];
  const administrator =
    users.find((user) => user.username === 'admin' && user.isAdmin) ??
    users.find((user) => user.isAdmin);
  if (original.some((group) => !group.owner) && !administrator)
    throw new Error('Legacy calling groups require an administrator owner');
  let changed = false;
  const groups = original.map((raw) => {
    const record = raw as UserGroup & { members?: unknown };
    const { members, ...group } = record;
    if (!group.owner || members !== undefined) changed = true;
    return { ...group, owner: group.owner || administrator!.username };
  });
  if (changed) await dao.update({ userGroups: groups });
  const keys = await getBearerKeyDao().findAll();
  for (const key of keys) {
    const group = groups.find((entry) => entry.id === key.userGroupId);
    if (group && !key.owner) await getBearerKeyDao().update(key.id, { owner: group.owner });
  }
}
