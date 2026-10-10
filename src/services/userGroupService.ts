import type { BearerKey, UserGroup, UserGroupResource } from '../types/index.js';
import type { RequestPrincipal } from './authorizationService.js';
import { getBearerKeyDao, getSystemConfigDao } from '../dao/index.js';
import { RequestContextService } from './requestContextService.js';
import { UserContextService } from './userContextService.js';

export interface UserGroupPolicy {
  restricted: boolean;
  groups: UserGroup[];
}

/** Resolve live permissions on every request; session creation is not an authorization cache. */
export async function getUserGroupPolicy(
  principal: RequestPrincipal | null = UserContextService.getInstance().getCurrentUser(),
  keyId = RequestContextService.getInstance().getBearerKeyContext().keyId,
): Promise<UserGroupPolicy> {
  const config = await getSystemConfigDao().get();
  const groups = config?.userGroups ?? [];
  const key: BearerKey | undefined = keyId ? await getBearerKeyDao()?.findById?.(keyId) : undefined;
  if (keyId && (!key || !key.enabled)) return { restricted: true, groups: [] };
  if (key?.userGroupId) {
    const group = groups.find((entry) => entry.id === key.userGroupId && entry.enabled);
    return { restricted: true, groups: key.enabled && group ? [group] : [] };
  }
  // Unbound system keys are shared/operator credentials, independent of memberships.
  if (key && key.kind !== 'user') return { restricted: false, groups: [] };
  if (!principal?.username || principal.isAdmin) return { restricted: false, groups: [] };
  const memberships = groups.filter((entry) => entry.members.includes(principal.username));
  return {
    restricted: memberships.length > 0,
    groups: memberships.filter((entry) => entry.enabled),
  };
}

export function userGroupAllows(policy: UserGroupPolicy, server: string, target?: string): boolean {
  if (!policy.restricted) return true;
  return policy.groups.some((group) =>
    group.servers.some(
      (resource: UserGroupResource) =>
        resource.name === server &&
        (target === undefined ||
          resource.targets === undefined ||
          resource.targets.includes(target)),
    ),
  );
}
