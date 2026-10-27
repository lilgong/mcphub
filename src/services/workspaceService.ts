import { validCredentialFile } from '../utils/workspaceSchema.js';
import { normalizeCredentialPrivateKeys } from '../utils/workspacePrivateKeys.js';
export { validCredentialFile } from '../utils/workspaceSchema.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getCredentialBindingDao } from '../dao/DaoFactory.js';
import { encryptCredentialValues, decryptCredentialValues } from './credentialBindingService.js';
import type { WorkspaceCredentials, WorkspaceRun } from '../types/workspace.js';

// Reserved identities cannot collide with valid MCP names. Reuse both DAO modes and
// the existing encrypted store; credentials never enter settings exports or logs.
const WORKSPACES = '@workspace';
const RUNS = '@workspace-run';
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
export const getWorkspace = (catalog: string, name: string) =>
  read<WorkspaceCredentials>(WORKSPACES, identity(catalog, name));
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
export async function listWorkspaces() {
  const active = await runs();
  const result = [];
  for (const id of await getCredentialBindingDao().listUsernames(WORKSPACES)) {
    const workspace = await read<WorkspaceCredentials>(WORKSPACES, id);
    if (workspace)
      result.push({
        catalog: workspace.catalog,
        name: workspace.name,
        allowedGroupIds: workspace.allowedGroupIds,
        revision: workspace.revision,
        connections: workspace.connections ?? {},
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
      connections,
      allowedGroupIds: [...new Set(groups)],
      values,
      files,
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
  });
}
export function startWorkspaceRun(
  catalog: string,
  workspace: string,
  owner: string,
  authorize: (workspace: WorkspaceCredentials) => Promise<boolean>,
) {
  return serial(async () => {
    const config = await getWorkspace(catalog, workspace);
    if (!config || !(await authorize(config)))
      throw new WorkspaceError('Workspace unavailable', 403);
    if ((await runs()).some((run) => run.catalog === catalog && run.workspace === workspace))
      throw new WorkspaceError('Workspace already belongs to another run', 409);
    const token = randomBytes(32).toString('hex');
    const run: WorkspaceRun = {
      id: randomUUID(),
      catalog,
      workspace,
      owner,
      tokenHash: digest(token),
      expiresAt: Date.now() + TTL,
    };
    await write(RUNS, run.id, run);
    return { id: run.id, token, expiresAt: run.expiresAt };
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
  await write(RUNS, run.id, run);
  return run.expiresAt;
}
export const finishWorkspaceRun = (run: WorkspaceRun) =>
  getCredentialBindingDao().delete({ serverName: RUNS, username: run.id });
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
export function releaseExpiredWorkspace(catalog: string, name: string) {
  return serial(async () => {
    identity(catalog, name);
    const matching = (await runs()).filter(
      (run) => run.catalog === catalog && run.workspace === name,
    );
    if (matching.some((run) => run.expiresAt > Date.now()))
      throw new WorkspaceError('The run is still active', 409);
    for (const run of matching) await finishWorkspaceRun(run);
  });
}
