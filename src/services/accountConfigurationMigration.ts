import { getServerDao, getSystemConfigDao } from '../dao/DaoFactory.js';
import { accountConnectionDefaults } from '../utils/accountConnection.js';
import { splitServerKey } from '../utils/catalog.js';
import { getWorkspace, saveWorkspace, validWorkspaceName } from './workspaceService.js';

/** Move resident target configurations into the same encrypted accounts used by task adapters. */
export async function migrateAccountConfigurations(): Promise<void> {
  const servers = await getServerDao().findAll();
  const system = await getSystemConfigDao().get();
  const groups = structuredClone(system.userGroups ?? []);
  let groupsChanged = false;
  for (const server of servers) {
    if (
      server.workspaceSchema?.connection ||
      !server.targets?.length ||
      server.targets.some((target) => target.kind !== 'static')
    )
      continue;
    const { catalog, name } = splitServerKey(server.name);
    if (!catalog) continue;
    const names = server.targets.map((target) =>
      target.path.startsWith(catalog + '/') ? target.path.slice(catalog.length + 1) : target.path,
    );
    if (names.some((value) => !validWorkspaceName(value)) || new Set(names).size !== names.length)
      throw new Error(`Account names require review for ${server.name}`);
    for (const [index, target] of server.targets.entries()) {
      const accountName = names[index];
      const current = await getWorkspace(catalog, accountName);
      const { path: _path, kind: _kind, ...connection } = target;
      const saved = current?.serverConnections?.[name];
      if (saved && JSON.stringify(saved) !== JSON.stringify(connection))
        throw new Error(`Account configuration conflict for ${server.name}`);
      const grants = groups
        .filter((group) =>
          group.servers.some(
            (resource) =>
              resource.name === server.name &&
              (!resource.targets || resource.targets.includes(target.path)),
          ),
        )
        .map((group) => group.id);
      if (!saved)
        await saveWorkspace(catalog, accountName, {
          revision: current?.revision,
          allowedGroupIds: [...new Set([...(current?.allowedGroupIds ?? []), ...grants])],
          values: {},
          files: {},
          serverConnections: { [name]: connection },
        });
      for (const group of groups)
        for (const resource of group.servers) {
          if (resource.name === server.name && resource.targets?.includes(target.path)) {
            resource.targets = resource.targets.map((path) =>
              path === target.path ? accountName : path,
            );
            groupsChanged = true;
          }
        }
    }
    const targets = server.targets.map((target, index) => ({
      ...target,
      path: names[index],
      config: accountConnectionDefaults(target.config ?? {}),
    }));
    if (groupsChanged) {
      await getSystemConfigDao().update({ userGroups: groups });
      groupsChanged = false;
    }
    await getServerDao().update(server.name, {
      ...server.targets[0].config,
      targets,
      workspaceSchema: { ...server.workspaceSchema, enabled: true, connection: true },
    });
  }
  if (groupsChanged) await getSystemConfigDao().update({ userGroups: groups });
}
