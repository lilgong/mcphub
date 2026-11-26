import type { ServerConfig } from '../types/index.js';
import type { TargetConnection } from '../types/targetConnection.js';
import { accountConnectionDefaults } from '../utils/accountConnection.js';
import { splitServerKey } from '../utils/catalog.js';
import { listWorkspaces, getWorkspace } from './workspaceService.js';

/** Target lists contain public launch metadata; credentials stay in the account store. */
export async function residentAccountTargets(
  server: string,
  definition: ServerConfig,
): Promise<TargetConnection[]> {
  const { catalog, name } = splitServerKey(server);
  const targets: TargetConnection[] = [];
  for (const summary of await listWorkspaces()) {
    if (summary.catalog !== catalog) continue;
    const workspace = await getWorkspace(catalog, summary.name);
    if (!workspace) continue;
    const stored = workspace.serverConnections?.[name];
    const mapped = (definition.workspaceSchema?.values ?? []).filter((field) => field.env);
    if (!stored && (!mapped.length || mapped.some((field) => !workspace.values[field.name])))
      continue;
    targets.push({
      ...stored,
      path: summary.name,
      kind: 'static',
      config: accountConnectionDefaults(stored?.config ?? definition),
    });
  }
  return targets;
}
