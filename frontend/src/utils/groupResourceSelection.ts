import { splitServerKey } from '../../../src/utils/catalog';
import type { UserGroupResource, UserGroupResourceOption } from '../../../src/types/userGroup';

export function filterGroupResources(
  servers: UserGroupResourceOption[],
  catalog: string,
  query: string,
): UserGroupResourceOption[] {
  const search = query.trim().toLowerCase();
  return servers.filter(
    (server) =>
      (catalog === '*' || splitServerKey(server.name).catalog === catalog) &&
      (!search || server.name.toLowerCase().includes(search)),
  );
}

/** Bulk actions touch exactly the visible resources, preserving other spaces and target subsets. */
export function selectVisibleGroupResources(
  selected: UserGroupResource[],
  visible: UserGroupResourceOption[],
  checked: boolean,
): UserGroupResource[] {
  const names = new Set(visible.map((server) => server.name));
  return [
    ...selected.filter((resource) => !names.has(resource.name)),
    ...(checked
      ? visible.map((server) => ({
          name: server.name,
          ...(server.targets.length
            ? { targets: server.targets.map((target) => target.path) }
            : {}),
        }))
      : []),
  ];
}
