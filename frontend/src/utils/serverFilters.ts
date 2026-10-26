import { Server } from '@/types';

export type ServerFilter = 'all' | 'online' | 'tasks' | 'issues' | 'disabled';

export interface ServerPageInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export const isTaskOnlyServer = (server: Server): boolean => {
  const targets = server.config?.targets ?? server.runtime?.targets;
  return !!targets?.length && targets.every((target) => target.kind === 'task');
};

export const isOnline = (server: Server): boolean =>
  server.status === 'connected' ||
  server.runtime?.instances.some((instance) => instance.status === 'connected') === true;

export const getServerFilterCounts = (servers: Server[]) => ({
  all: servers.length,
  online: servers.filter(isOnline).length,
  tasks: servers.filter((server) => server.enabled !== false && isTaskOnlyServer(server)).length,
  issues: servers.filter(
    (server) => !isOnline(server) && !isTaskOnlyServer(server) && server.enabled !== false,
  ).length,
  disabled: servers.filter((server) => server.enabled === false).length,
});

export const filterServers = (servers: Server[], filter: ServerFilter, search = ''): Server[] => {
  const query = search.trim().toLowerCase();

  return servers.filter((server) => {
    if (filter === 'online' && !isOnline(server)) return false;
    if (filter === 'tasks' && (!isTaskOnlyServer(server) || server.enabled === false)) return false;
    if (
      filter === 'issues' &&
      (isOnline(server) || isTaskOnlyServer(server) || server.enabled === false)
    )
      return false;
    if (filter === 'disabled' && server.enabled !== false) return false;
    if (!query) return true;

    const haystack = (
      server.name +
      ' ' +
      (server.config?.description || '') +
      ' ' +
      (server.tools?.map((tool) => tool.name).join(' ') || '') +
      ' ' +
      (server.runtime?.targets
        .map((target) =>
          [target.path, target.implementation, target.configuredVersion].filter(Boolean).join(' '),
        )
        .join(' ') || '') +
      ' ' +
      (server.runtime?.instances
        .map((instance) =>
          [instance.reportedVersion, instance.packageVersion].filter(Boolean).join(' '),
        )
        .join(' ') || '')
    ).toLowerCase();

    return haystack.includes(query);
  });
};

// Filters the full server list then paginates the filtered result client-side.
// Filtering must run against the complete list, not a single pagination page, so
// that servers on other pages remain reachable when a status filter is active.
export const selectServerPage = (
  allServers: Server[],
  filter: ServerFilter,
  search: string,
  page: number,
  limit: number,
): { servers: Server[]; pagination: ServerPageInfo } => {
  const filtered = filterServers(allServers, filter, search);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * limit;

  return {
    servers: filtered.slice(start, start + limit),
    pagination: {
      page: safePage,
      limit,
      total,
      totalPages,
      hasNextPage: safePage < totalPages,
      hasPrevPage: safePage > 1,
    },
  };
};
