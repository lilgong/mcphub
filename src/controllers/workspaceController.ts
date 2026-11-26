import { validateDocument } from '../utils/workspaceDocuments.js';
import { accountConnectionDefaults, hasResidentAccounts } from '../utils/accountConnection.js';
import { normalizeTargetConnections } from '../utils/targetConnection.js';
import { workspaceHttpUrl, workspaceHttpSecret } from '../utils/workspaceHttp.js';
import { selectWorkspaceMaterial } from '../utils/workspaceMaterial.js';
import { splitServerKey } from '../utils/catalog.js';
import { getServerDao } from '../dao/DaoFactory.js';
import type { Request, Response } from 'express';
import { getUserGroupPolicy, userGroupAllows } from '../services/userGroupService.js';
import type { WorkspaceCredentials, WorkspaceCredentialSchema } from '../types/workspace.js';
import {
  WorkspaceError,
  listWorkspaces,
  getWorkspace,
  saveWorkspace,
  setWorkspaceEnabled,
  deleteWorkspace,
  startWorkspaceRun,
  accessWorkspaceRun,
  updateWorkspaceRun,
  finishWorkspaceRun,
  syncWorkspaceFiles,
  releaseExpiredWorkspace,
  reportWorkspaceRun,
  workspaceExitReason,
} from '../services/workspaceService.js';

type Caller = Request & {
  user?: { username: string; isAdmin: boolean; credentialEligible?: boolean };
  bearerKey?: { id: string; userGroupId?: string };
};
function administrator(req: Caller): boolean {
  // Calling keys, including administrator-owned group keys, never administer secrets.
  return !!req.user?.isAdmin && !req.bearerKey && req.user.credentialEligible !== false;
}
export async function canUseWorkspace(
  req: Caller,
  workspace: WorkspaceCredentials,
): Promise<boolean> {
  if (administrator(req)) return true;
  if (!req.bearerKey?.userGroupId) return false;
  const policy = await getUserGroupPolicy(null, req.bearerKey.id);
  return policy.groups.some(
    (group) =>
      workspace.allowedGroupIds.includes(group.id) &&
      group.servers.some((server) => server.name.startsWith(`${workspace.catalog}::`)),
  );
}
const owner = (req: Caller): string => req.bearerKey?.id || `user:${req.user?.username}`;
const token = (req: Request): string => req.get('X-MCPHub-Run-Token') || '';
const errorResponse = (res: Response, error: unknown): void => {
  res.status(error instanceof WorkspaceError ? error.status : 500).json({
    success: false,
    message:
      error instanceof WorkspaceError ? error.message : 'Workspace credential operation failed',
  });
};
export async function workspaceManagement(req: Caller, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (!administrator(req)) {
    res.status(403).json({ success: false });
    return;
  }
  try {
    const catalog = String(req.params.catalog);
    const name = String(req.params.workspace);
    if (req.method === 'GET') res.json({ success: true, data: await listWorkspaces() });
    else {
      if (req.method === 'POST') await releaseExpiredWorkspace(catalog, name, req.body);
      else if (req.method === 'DELETE') {
        await deleteWorkspace(catalog, name);
        for (const server of await getServerDao().findAll()) {
          if (splitServerKey(server.name).catalog !== catalog || !hasResidentAccounts(server))
            continue;
          await getServerDao().update(server.name, {
            targets: server.targets?.filter((target) => target.path !== name),
          });
        }
      } else await saveWorkspace(catalog, name, req.body ?? {});
      res.json({ success: true });
    }
  } catch (error) {
    errorResponse(res, error);
  }
}
export async function workspaceEnabled(req: Caller, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (!administrator(req)) {
    res.status(403).json({ success: false });
    return;
  }
  try {
    await setWorkspaceEnabled(
      String(req.params.catalog),
      String(req.params.workspace),
      req.body?.enabled,
      req.body?.revision,
    );
    res.json({ success: true });
  } catch (error) {
    errorResponse(res, error);
  }
}
export async function workspaceAvailability(req: Caller, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!req.user) throw new WorkspaceError('Authentication required', 403);
    const catalog = req.query.catalog;
    if (typeof catalog !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(catalog))
      throw new WorkspaceError('Select a valid space');
    const accounts = [];
    for (const entry of await listWorkspaces()) {
      if (entry.catalog !== catalog) continue;
      const account = await getWorkspace(catalog, entry.name);
      if (!account || !(await canUseWorkspace(req, account))) continue;
      accounts.push({
        name: entry.name,
        enabled: account.enabled !== false,
        ready: entry.ready,
        missing: entry.missing,
        busy: entry.busy,
        expired: entry.expired,
        state: entry.run?.state ?? 'idle',
      });
    }
    accounts.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, data: { accounts } });
  } catch (error) {
    errorResponse(res, error);
  }
}

export async function createWorkspaceRun(req: Caller, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!req.user) throw new WorkspaceError('Authentication required', 403);
    const { catalog, workspace } = req.body ?? {};
    if (typeof catalog !== 'string' || (workspace !== undefined && typeof workspace !== 'string'))
      throw new WorkspaceError('Select a space and workspace');
    res.json({
      success: true,
      data: await startWorkspaceRun(catalog, workspace, owner(req), (config) =>
        canUseWorkspace(req, config),
      ),
    });
  } catch (error) {
    errorResponse(res, error);
  }
}
export async function workspaceRun(req: Caller, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const id = String(req.params.id);
    const access = () =>
      accessWorkspaceRun(id, token(req), owner(req), (config) => canUseWorkspace(req, config));
    if (req.method === 'GET') {
      const { run, workspace } = await access();
      const definitions = await getServerDao().findAll();
      const schemas = definitions
        .filter(
          (server) => splitServerKey(server.name).catalog === run.catalog && server.workspaceSchema,
        )
        .map((server) => server.workspaceSchema!);
      const material = selectWorkspaceMaterial(workspace, schemas);
      const policy = await getUserGroupPolicy(req.user ?? null, req.bearerKey?.id);
      const http = definitions
        .filter(
          (server) =>
            splitServerKey(server.name).catalog === run.catalog &&
            server.enabled !== false &&
            server.workspaceSchema?.enabled === true &&
            (server.targets?.length
              ? server.targets.some(
                  (target) =>
                    target.kind === 'task' &&
                    target.enabled !== false &&
                    userGroupAllows(policy, server.name, target.path),
                )
              : userGroupAllows(policy, server.name)),
        )
        .flatMap((server) =>
          (server.workspaceSchema?.http ?? [])
            .filter((binding) => binding.credential.forward || binding.assetHosts)
            .flatMap((binding) => {
              try {
                if (!workspaceHttpSecret(binding, workspace)) return [];
                return [
                  {
                    server: splitServerKey(server.name).name,
                    id: binding.id,
                    url: workspaceHttpUrl(binding, workspace),
                    field: binding.credential.field,
                    protocol: binding.protocol ?? 'http',
                    ...(binding.assetHosts ? { assetHosts: binding.assetHosts } : {}),
                  },
                ];
              } catch {
                return [];
              }
            }),
        );
      res.json({
        success: true,
        data: {
          catalog: run.catalog,
          workspace: run.workspace,
          values: material.values,
          files: material.files,
          revision: workspace.revision,
          http,
        },
      });
      return;
    }
    await updateWorkspaceRun(id, async () => {
      // Revalidate capability, live group grants and expiration inside the serialized update.
      const { run } = await access();
      if (req.method === 'DELETE')
        await finishWorkspaceRun(run, workspaceExitReason(req.body?.exitReason));
      else if (/\/files\/?$/.test(req.path)) await syncWorkspaceFiles(run, req.body?.updates);
      else await reportWorkspaceRun(run, req.body ?? {});
    });
    res.json({ success: true });
  } catch (error) {
    errorResponse(res, error);
  }
}

/** Administrator-only editor; lists are metadata-only and explicit account reads are scoped. */
export async function serverWorkspaceAccounts(req: Caller, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (!administrator(req)) {
    res.status(403).json({ success: false });
    return;
  }
  try {
    const { getServerDao } = await import('../dao/DaoFactory.js');
    const { splitServerKey } = await import('../utils/catalog.js');
    const definition = await getServerDao().findById(String(req.params.name));
    const schema: WorkspaceCredentialSchema | undefined =
      definition?.workspaceSchema ??
      (req.query.connection === '1' &&
      definition &&
      !definition.targets?.some((target) => target.kind === 'task') &&
      !['openapi', 'http-proxy'].includes(definition.type || '')
        ? { connection: true, enabled: false }
        : undefined);
    const { catalog, name } = splitServerKey(String(req.params.name));
    if (!definition || !catalog || !schema)
      throw new WorkspaceError('Server has no startup account declaration', 404);
    if (req.method === 'GET' && req.query.defaults === '1' && schema.connection) {
      res.json({ success: true, data: { connection: accountConnectionDefaults(definition) } });
      return;
    }
    if (req.method === 'GET' && req.params.account) {
      const { getWorkspace } = await import('../services/workspaceService.js');
      const account = await getWorkspace(catalog, String(req.params.account));
      if (!account) throw new WorkspaceError('Account not found', 404);
      res.json({
        success: true,
        data: {
          revision: account.revision,
          allowedGroupIds: account.allowedGroupIds,
          ...(schema.connection
            ? {
                connection:
                  account.serverConnections?.[name]?.config ??
                  accountConnectionDefaults(definition),
              }
            : {}),
          values: Object.fromEntries(
            Object.entries(account.values).filter(([field]) =>
              schema.values?.some((entry) => entry.name === field),
            ),
          ),
          files: Object.fromEntries(
            Object.entries(account.files).filter(([path]) =>
              schema.files?.some((entry) =>
                entry.directory ? path.startsWith(entry.path + '/') : entry.path === path,
              ),
            ),
          ),
        },
      });
      return;
    }
    if (req.method === 'GET') {
      const accounts = (await listWorkspaces()).filter((account) => account.catalog === catalog);
      res.json({ success: true, data: { schema, accounts } });
      return;
    }
    const accountName = String(req.params.account);
    const body = req.body ?? {};
    const values = body.values ?? {};
    const files = body.files ?? {};
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      !files ||
      typeof files !== 'object' ||
      Array.isArray(files)
    )
      throw new WorkspaceError('Invalid account fields');
    const fields = new Set(schema.values?.map((field) => field.name));
    if (
      Object.keys(values).some((field) => !fields.has(field)) ||
      Object.keys(files).some(
        (path) =>
          !schema.files?.some((file) =>
            file.directory ? path.startsWith(file.path + '/') : path === file.path,
          ),
      )
    )
      throw new WorkspaceError('Only this MCP’s declared account fields may be updated');
    for (const file of schema.files || []) {
      const content = files[file.path];
      if (
        content !== undefined &&
        (typeof content !== 'string' || !validateDocument(file, content))
      )
        throw new WorkspaceError('Invalid credential document: ' + file.path);
    }
    const { getWorkspace } = await import('../services/workspaceService.js');
    const current = await getWorkspace(catalog, accountName);
    if (body.connection !== undefined && !schema.connection)
      throw new WorkspaceError(
        'This MCP is started by its task adapter; Hub cannot change its executable',
      );
    if (body.connection !== undefined) {
      try {
        normalizeTargetConnections([
          { path: accountName, kind: 'static', config: body.connection },
        ]);
      } catch {
        throw new WorkspaceError('Invalid account launch configuration');
      }
    }
    const connections = { ...current?.connections };
    const mapping = Object.fromEntries(
      (schema.values ?? []).filter((field) => field.env).map((field) => [field.env!, field.name]),
    );
    if (Object.keys(mapping).length) connections[name] = mapping;
    await saveWorkspace(catalog, accountName, {
      values,
      files,
      connections,
      allowedGroupIds: body.allowedGroupIds ?? current?.allowedGroupIds ?? [],
      revision: body.revision,
      ...(body.connection !== undefined
        ? {
            serverConnections: {
              [name]: { ...current?.serverConnections?.[name], config: body.connection },
            },
          }
        : {}),
    });
    if (schema.connection && schema.enabled) {
      const saved = await getWorkspace(catalog, accountName);
      const connection = saved?.serverConnections?.[name];
      const metadata = {
        path: accountName,
        kind: 'static' as const,
        ...connection,
        config: accountConnectionDefaults((connection?.config ?? definition) as typeof definition),
      };
      await getServerDao().update(definition.name, {
        targets: [
          ...(definition.targets ?? []).filter((target) => target.path !== accountName),
          metadata,
        ],
      });
    }
    res.json({ success: true });
  } catch (error) {
    errorResponse(res, error);
  }
}
