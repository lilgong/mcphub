import { githubPoolSnapshot, releaseGithubTasks } from './githubPoolService.js';
import { releaseGithubPreparations } from './githubPreparationService.js';
import { workspaceReadiness } from '../utils/workspaceReadiness.js';
import { getServerDao } from '../dao/DaoFactory.js';
import { validCredentialFile } from '../utils/workspaceSchema.js';
import { normalizeCredentialPrivateKeys } from '../utils/workspacePrivateKeys.js';
import { normalizeTargetConnections } from '../utils/targetConnection.js';
export { validCredentialFile } from '../utils/workspaceSchema.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getCredentialBindingDao } from '../dao/DaoFactory.js';
import {
  encryptCredentialValues,
  decryptCredentialValues,
  credentialBindingEvents,
} from './credentialBindingService.js';
import type {
  WorkspaceCredentials,
  WorkspaceRun,
  WorkspaceRunSummary,
  WorkspaceExitReason,
} from '../types/workspace.js';

// Reserved identities cannot collide with valid MCP names. Reuse both DAO modes and
// the existing encrypted store; credentials never enter settings exports or logs.
const WORKSPACES = '@workspace';
const RUNS = '@workspace-run';
const LAST_RUNS = '@workspace-last-run';
const TTL = 10 * 60 * 1000;
let pending: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation, operation);
  pending = result.catch(() => undefined);
  return result;
}
export class WorkspaceError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const validWorkspaceName = (name: unknown): name is string =>
  typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name);
const identity = (catalog: string, name: string): string => {
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(catalog) || !validWorkspaceName(name))
    throw new WorkspaceError('Invalid space or workspace name');
  return `${catalog}/${name}`;
};

function strings(value: unknown, files = false): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkspaceError('Expected named text values');
  const entries = Object.entries(value);
  if (
    entries.length > 256 ||
    entries.some(
      ([key, content]) =>
        !(files ? validCredentialFile(key) : /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(key)) ||
        typeof content !== 'string' ||
        content.includes('\0') ||
        content.length > 1024 * 1024,
    )
  )
    throw new WorkspaceError('Invalid credential field or file path');
  if (JSON.stringify(value).length > 8 * 1024 * 1024)
    throw new WorkspaceError('Credential payload exceeds 8 MiB');
  return Object.fromEntries(
    entries.map(([name, content]) => {
      try {
        return [name, normalizeCredentialPrivateKeys(content as string)];
      } catch {
        throw new WorkspaceError(`Invalid PEM private key in credential field or file: ${name}`);
      }
    }),
  );
}
async function read<T>(kind: string, id: string): Promise<T | null> {
  const stored = await getCredentialBindingDao().get(kind, id);
  if (!stored) return null;
  const record = await decryptCredentialValues(stored);
  return JSON.parse(record.payload) as T;
}
async function write(kind: string, id: string, payload: unknown): Promise<void> {
  await getCredentialBindingDao().save({
    serverName: kind,
    username: id,
    encryptedValues: await encryptCredentialValues(kind, id, { payload: JSON.stringify(payload) }),
    updatedAt: new Date().toISOString(),
  });
}
export async function getWorkspace(
  catalog: string,
  name: string,
): Promise<WorkspaceCredentials | null> {
  const workspace = await read<WorkspaceCredentials>(WORKSPACES, identity(catalog, name));
  if (!workspace) return null;
  // Older saved accounts predate PEM normalization on write. Canonicalize the
  // exported view without changing stored OAuth state or another active run.
  return { ...workspace, values: strings(workspace.values), files: strings(workspace.files, true) };
}
async function runs(): Promise<WorkspaceRun[]> {
  const result: WorkspaceRun[] = [];
  for (const id of await getCredentialBindingDao().listUsernames(RUNS)) {
    const run = await read<WorkspaceRun>(RUNS, id);
    // Expired runs remain occupied until an operator recovers their OAuth state.
    // Automatically freeing them can reuse a rotated, stale refresh token.
    if (run) result.push(run);
  }
  return result;
}
function runSummary(run: WorkspaceRun): WorkspaceRunSummary {
  return {
    id: run.id,
    startedAt: run.startedAt,
    heartbeatAt: run.heartbeatAt,
    lastSyncAt: run.lastSyncAt,
    expiresAt: run.expiresAt,
    state: run.state ?? 'running',
    lastError: run.lastError,
  };
}
export async function listWorkspaces() {
  const active = await runs();
  const definitions = await getServerDao().findAll();
  const result = [];
  for (const id of await getCredentialBindingDao().listUsernames(WORKSPACES)) {
    const workspace = await read<WorkspaceCredentials>(WORKSPACES, id);
    if (workspace)
      result.push({
        ...workspaceReadiness(
          workspace,
          definitions,
          !!(await githubPoolSnapshot(workspace.catalog))?.accounts.length,
        ),
        catalog: workspace.catalog,
        name: workspace.name,
        enabled: workspace.enabled !== false,
        allowedGroupIds: workspace.allowedGroupIds,
        revision: workspace.revision,
        connections: workspace.connections ?? {},
        servers: Object.keys(workspace.serverConnections ?? {}),
        run: active.find(
          (run) => run.catalog === workspace.catalog && run.workspace === workspace.name,
        )
          ? runSummary(
              active.find(
                (run) => run.catalog === workspace.catalog && run.workspace === workspace.name,
              )!,
            )
          : undefined,
        lastRun: (await read<WorkspaceRunSummary>(LAST_RUNS, id)) ?? undefined,
        fields: Object.keys(workspace.values),
        files: Object.keys(workspace.files),
        expired: active.some(
          (run) =>
            run.catalog === workspace.catalog &&
            run.workspace === workspace.name &&
            run.expiresAt <= Date.now(),
        ),
        busy: active.some(
          (run) => run.catalog === workspace.catalog && run.workspace === workspace.name,
        ),
      });
  }
  return result;
}
export function saveWorkspace(
  catalog: string,
  name: string,
  input: {
    values?: unknown;
    files?: unknown;
    connections?: unknown;
    serverConnections?: WorkspaceCredentials['serverConnections'];
    allowedGroupIds?: unknown;
    revision?: unknown;
  },
): Promise<void> {
  return serial(async () => {
    const id = identity(catalog, name);
    const current = await getWorkspace(catalog, name);
    if ((await runs()).some((run) => run.catalog === catalog && run.workspace === name))
      throw new WorkspaceError('Workspace is in use; finish the run before editing', 409);
    if (current && input.revision !== current.revision)
      throw new WorkspaceError('Workspace changed; reload before saving', 409);
    const groups = input.allowedGroupIds;
    if (!Array.isArray(groups) || groups.some((group) => typeof group !== 'string' || !group))
      throw new WorkspaceError('Select the calling groups allowed to use these credentials');
    const values = { ...current?.values, ...strings(input.values ?? {}) };
    const files = { ...current?.files, ...strings(input.files ?? {}, true) };
    const connections = input.connections ?? current?.connections ?? {};
    const serverConnections = { ...current?.serverConnections };
    if (input.serverConnections) {
      if (
        typeof input.serverConnections !== 'object' ||
        Array.isArray(input.serverConnections) ||
        JSON.stringify(input.serverConnections).length > 8 * 1024 * 1024
      )
        throw new WorkspaceError('Invalid account launch configuration');
      for (const [server, connection] of Object.entries(input.serverConnections)) {
        if (!/^[a-zA-Z0-9_.-]+$/.test(server)) throw new WorkspaceError('Invalid MCP binding');
        const normalized = normalizeTargetConnections([
          { ...connection, path: name, kind: 'static' },
        ])![0];
        const { path: _path, kind: _kind, ...stored } = normalized;
        serverConnections[server] = stored;
      }
    }
    if (!connections || typeof connections !== 'object' || Array.isArray(connections))
      throw new WorkspaceError('Invalid MCP environment bindings');
    for (const [server, fields] of Object.entries(connections)) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(server)) throw new WorkspaceError('Invalid MCP binding');
      const mapping = strings(fields);
      if (Object.values(mapping).some((field) => !/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(field)))
        throw new WorkspaceError('MCP bindings must reference credential field names');
    }
    await write(WORKSPACES, id, {
      catalog,
      name,
      enabled: current?.enabled !== false,
      connections,
      serverConnections,
      allowedGroupIds: [...new Set(groups)],
      values,
      files,
      revision: randomUUID(),
    });
    credentialBindingEvents.emit('workspace-changed', { catalog, name });
  });
}
/** Admission only: existing runs keep their credentials and can synchronize/release. */
export function setWorkspaceEnabled(
  catalog: string,
  name: string,
  enabled: unknown,
  revision: unknown,
): Promise<void> {
  return serial(async () => {
    if (typeof enabled !== 'boolean') throw new WorkspaceError('Enabled must be a boolean');
    const current = await getWorkspace(catalog, name);
    if (!current) throw new WorkspaceError('Account not found', 404);
    if (revision !== current.revision)
      throw new WorkspaceError('Workspace changed; reload before saving', 409);
    await write(WORKSPACES, identity(catalog, name), {
      ...current,
      enabled,
      revision: randomUUID(),
    });
  });
}
export function deleteWorkspace(catalog: string, name: string): Promise<void> {
  return serial(async () => {
    if ((await runs()).some((run) => run.catalog === catalog && run.workspace === name))
      throw new WorkspaceError('Workspace is in use', 409);
    await getCredentialBindingDao().delete({
      serverName: WORKSPACES,
      username: identity(catalog, name),
    });
    credentialBindingEvents.emit('workspace-changed', { catalog, name });
  });
}
export function startWorkspaceRun(
  catalog: string,
  workspace: string | undefined,
  owner: string,
  authorize: (workspace: WorkspaceCredentials) => Promise<boolean>,
  githubTaskLeases = false,
) {
  return serial(async () => {
    const githubPool = await githubPoolSnapshot(catalog);
    if (githubPool?.accounts.length && !githubTaskLeases)
      throw new WorkspaceError('This catalog requires a runner supporting GitHub task leases', 422);
    const activeRuns = (await runs()).filter((run) => run.catalog === catalog);
    if (
      activeRuns.some((run) => !!run.githubPool?.accounts.length !== !!githubPool?.accounts.length)
    )
      throw new WorkspaceError('Drain this catalog before switching GitHub pool mode', 409);
    const definitions = await getServerDao().findAll();
    if (workspace === undefined) {
      if (!/^[a-z][a-z0-9_-]{0,47}$/.test(catalog)) throw new WorkspaceError('Invalid space');
      const active = await runs();
      const candidates = (await listWorkspaces())
        .filter((entry) => entry.catalog === catalog)
        .sort((a, b) => a.name.localeCompare(b.name));
      let authorized = false;
      for (const candidate of candidates) {
        const account = await getWorkspace(catalog, candidate.name);
        if (!account || !(await authorize(account))) continue;
        authorized = true;
        if (account.enabled === false) continue;
        if (!workspaceReadiness(account, definitions, !!githubPool?.accounts.length).ready)
          continue;
        if (active.some((run) => run.catalog === catalog && run.workspace === candidate.name))
          continue;
        workspace = candidate.name;
        break;
      }
      if (!authorized) throw new WorkspaceError('Workspace unavailable', 403);
      if (workspace === undefined) throw new WorkspaceError('No available workspace account', 409);
    }
    const config = await getWorkspace(catalog, workspace);
    if (!config || !(await authorize(config)))
      throw new WorkspaceError('Workspace unavailable', 403);
    if (config.enabled === false) throw new WorkspaceError('Workspace account is disabled', 409);
    if ((await runs()).some((run) => run.catalog === catalog && run.workspace === workspace))
      throw new WorkspaceError(
        'Workspace already belongs to another run; exit the previous workspace terminal or review its run status in the dashboard',
        409,
      );
    const readiness = workspaceReadiness(config, definitions, !!githubPool?.accounts.length);
    if (!readiness.ready)
      throw new WorkspaceError(
        `Workspace credentials are incomplete: ${readiness.missing.join('; ')}`,
        422,
      );
    const token = randomBytes(32).toString('hex');
    const run: WorkspaceRun = {
      githubPool,
      id: randomUUID(),
      catalog,
      workspace,
      owner,
      tokenHash: digest(token),
      expiresAt: Date.now() + TTL,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      state: 'running',
    };
    await write(RUNS, run.id, run);
    return { id: run.id, token, expiresAt: run.expiresAt, workspace };
  });
}
export async function accessWorkspaceRun(
  id: string,
  token: string,
  owner: string,
  authorize: (workspace: WorkspaceCredentials) => Promise<boolean>,
) {
  const run = await read<WorkspaceRun>(RUNS, id);
  if (!run || run.expiresAt <= Date.now() || run.owner !== owner || run.tokenHash !== digest(token))
    throw new WorkspaceError('Run unavailable or expired', 403);
  const workspace = await getWorkspace(run.catalog, run.workspace);
  if (!workspace || !(await authorize(workspace)))
    throw new WorkspaceError('Workspace unavailable', 403);
  return { run, workspace };
}
export function updateWorkspaceRun(id: string, operation: (run: WorkspaceRun) => Promise<void>) {
  return serial(async () => {
    const run = await read<WorkspaceRun>(RUNS, id);
    if (!run || run.expiresAt <= Date.now()) throw new WorkspaceError('Run expired', 403);
    await operation(run);
  });
}
export async function renewWorkspaceRun(run: WorkspaceRun) {
  run.expiresAt = Date.now() + TTL;
  run.heartbeatAt = Date.now();
  await write(RUNS, run.id, run);
  return run.expiresAt;
}
export async function finishWorkspaceRun(
  run: WorkspaceRun,
  exitReason: WorkspaceExitReason | 'administrator_recovery' = 'completed',
) {
  await write(LAST_RUNS, identity(run.catalog, run.workspace), {
    ...runSummary(run),
    endedAt: Date.now(),
    exitReason,
  });
  await releaseGithubPreparations(run.id, () =>
    releaseGithubTasks(run.id, () =>
      getCredentialBindingDao().delete({ serverName: RUNS, username: run.id }),
    ),
  );
}
export async function reportWorkspaceRun(run: WorkspaceRun, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new WorkspaceError('Invalid workspace run status');
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['syncComplete', 'error'].includes(key)) ||
    (value.syncComplete !== undefined && typeof value.syncComplete !== 'boolean') ||
    (value.error !== undefined &&
      !['sync_failed', 'connection_failed', 'cleanup_failed'].includes(String(value.error)))
  )
    throw new WorkspaceError('Invalid workspace run status');
  if (value.syncComplete === true) {
    run.lastSyncAt = Date.now();
    run.lastError = undefined;
    run.state = 'running';
  }
  if (value.error) {
    run.lastError = value.error as WorkspaceRun['lastError'];
    run.state = 'recovery_required';
  }
  await renewWorkspaceRun(run);
}
export function workspaceExitReason(value: unknown): WorkspaceExitReason {
  if (value === undefined) return 'completed';
  if (!['completed', 'cancelled', 'command_failed', 'startup_failed'].includes(String(value)))
    throw new WorkspaceError('Invalid workspace exit reason');
  return value as WorkspaceExitReason;
}
/** Compare each changed file independently: unrelated updates must not overwrite rotated tokens. */
export async function syncWorkspaceFiles(run: WorkspaceRun, input: unknown) {
  if (!Array.isArray(input) || input.length > 256) throw new WorkspaceError('Invalid file updates');
  const workspace = await getWorkspace(run.catalog, run.workspace);
  if (!workspace) throw new WorkspaceError('Workspace unavailable', 403);
  for (const update of input) {
    if (
      !update ||
      typeof update.path !== 'string' ||
      !/^(configs\/\.mcp-auth\/|configs\/(google_credentials|credentials)\.json$)/.test(update.path)
    )
      throw new WorkspaceError('Only OAuth state may be updated by a run');
    strings({ [update.path]: update.content }, true);
    const current = workspace.files[update.path];
    if (update.expectedHash !== (current === undefined ? null : digest(current)))
      throw new WorkspaceError(
        'OAuth state changed; refusing to overwrite newer authorization',
        409,
      );
  }
  for (const update of input) workspace.files[update.path] = update.content;
  workspace.revision = randomUUID();
  await write(WORKSPACES, identity(run.catalog, run.workspace), workspace);
  run.lastSyncAt = Date.now();
  await write(RUNS, run.id, run);
}

/** Recheck a bound task's account lease without revealing its capability. */
export async function boundWorkspaceRun(
  id: string,
  owner: string,
  catalog: string,
  authorize: (workspace: WorkspaceCredentials) => Promise<boolean>,
) {
  const run = await read<WorkspaceRun>(RUNS, id);
  if (!run || run.owner !== owner || run.catalog !== catalog || run.expiresAt <= Date.now())
    throw new WorkspaceError('Task account lease is unavailable', 403);
  const workspace = await getWorkspace(run.catalog, run.workspace);
  if (!workspace || !(await authorize(workspace)))
    throw new WorkspaceError('Workspace unavailable', 403);
  return run;
}

/** Explicit administrator recovery only; never silently free a lost account lease. */
export function releaseExpiredWorkspace(
  catalog: string,
  name: string,
  input?: { runId?: unknown; stopped?: unknown; authorizationReviewed?: unknown },
) {
  return serial(async () => {
    identity(catalog, name);
    const matching = (await runs()).filter(
      (run) => run.catalog === catalog && run.workspace === name,
    );
    if (matching.length !== 1 || matching[0].id !== input?.runId)
      throw new WorkspaceError('Workspace run changed; refresh before recovery', 409);
    if (input.stopped !== true || input.authorizationReviewed !== true)
      throw new WorkspaceError(
        'Confirm the previous run stopped and authorization state was reviewed',
        400,
      );
    for (const run of matching) await finishWorkspaceRun(run, 'administrator_recovery');
  });
}
