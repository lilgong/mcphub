import type { ServerConfig } from '../types/index.js';
import type { RequestPrincipal } from './authorizationService.js';
import { getWorkspace } from './workspaceService.js';
import { getUserGroupPolicy, userGroupAllows } from './userGroupService.js';
import { splitServerKey } from '../utils/catalog.js';
import { hasResidentAccounts } from '../utils/accountConnection.js';

/** Only explicit operator bindings opt a resident MCP into workspace credentials. */
export async function workspaceDefinition(
  server: string,
  definition: ServerConfig,
  path: string | undefined,
  principal: RequestPrincipal | null | undefined,
  keyId?: string,
): Promise<ServerConfig | undefined> {
  const managed = hasResidentAccounts(definition);
  if (definition.targets?.length && !managed) return undefined;
  if (definition.workspaceSchema && !definition.workspaceSchema.enabled) return undefined;
  if (!path) {
    if (managed) throw new Error('An explicit X-MCPHub-Target account is required');
    return undefined;
  }
  const { catalog, name } = splitServerKey(server);
  if (!catalog || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(path)) {
    if (managed) throw new Error('Invalid account name');
    return undefined;
  }
  const workspace = await getWorkspace(catalog, path);
  const declared = Object.fromEntries(
    (definition.workspaceSchema?.values ?? [])
      .filter((field) => field.env)
      .map((field) => [field.env!, field.name]),
  );
  const mapping = { ...workspace?.connections?.[name], ...declared };
  const stored = workspace?.serverConnections?.[name];
  if (!workspace || (!stored && !Object.keys(mapping).length)) {
    if (managed) throw new Error('Account is not configured for this MCP');
    return undefined;
  }
  if (definition.type === 'openapi' || definition.type === 'http-proxy')
    throw new Error('Workspace environment binding requires an MCP transport');
  const policy = await getUserGroupPolicy(principal ?? null, keyId);
  const permitted = policy.restricted
    ? policy.groups.some((group) => workspace.allowedGroupIds.includes(group.id)) &&
      userGroupAllows(policy, server, path)
    : principal?.isAdmin === true && !keyId;
  if (!permitted) throw new Error('Workspace not available for this caller');
  const connection = stored?.config;
  const env = { ...(connection ? connection.env : definition.env) };
  for (const [key, field] of Object.entries(mapping)) {
    const value = workspace.values[field];
    if (!value) throw new Error('Required workspace credential is not configured');
    env[key] = value;
  }
  return {
    ...definition,
    targets: [
      {
        path,
        kind: 'static',
        ...stored,
        enabled: stored?.enabled !== false,
        config: {
          ...(connection ?? {
            type: definition.type,
            command: definition.command,
            args: definition.args,
            url: definition.url,
            headers: definition.headers,
            options: definition.options,
            keyPool: definition.keyPool,
            relay: definition.relay,
          }),
          env,
        },
      },
    ],
  };
}
