import { randomUUID } from 'node:crypto';
import { getCredentialBindingDao } from '../dao/DaoFactory.js';
import { decryptCredentialValues, encryptCredentialValues } from './credentialBindingService.js';
import { githubThrottleStore } from './githubThrottleStore.js';
import { withGithubTaskPreparationCleanup } from './githubPreparationService.js';
import type {
  GithubPoolAccount,
  GithubPoolSnapshot,
  GithubTaskLease,
} from '../types/githubPool.js';

const CONFIG = '@github-pool';
const LEASES = '@github-task-lease';
const RETIRED = '@github-task-retired';
let pending: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation, operation);
  pending = result.catch(() => undefined);
  return result;
}
async function read<T>(kind: string, id: string): Promise<T | undefined> {
  const record = await getCredentialBindingDao().get(kind, id);
  return record ? JSON.parse((await decryptCredentialValues(record)).payload) : undefined;
}
async function write(kind: string, id: string, payload: unknown) {
  await getCredentialBindingDao().save({
    serverName: kind,
    username: id,
    encryptedValues: await encryptCredentialValues(kind, id, { payload: JSON.stringify(payload) }),
    updatedAt: new Date().toISOString(),
  });
}
export const githubPoolSnapshot = (catalog: string) => read<GithubPoolSnapshot>(CONFIG, catalog);
export async function saveGithubPool(catalog: string, accounts: GithubPoolAccount[]) {
  if (new Set(accounts.map((a) => a.id)).size !== accounts.length)
    throw new Error('Duplicate GitHub identity');
  await write(CONFIG, catalog, { revision: randomUUID(), accounts });
}
const key = (run: string, task: string) => `${run}/${task}`;
export function acquireGithubTask(
  snapshot: GithubPoolSnapshot,
  run: string,
  task: string,
  holder: string,
  authorize: () => Promise<unknown>,
): Promise<GithubTaskLease | undefined> {
  return serial(async () => {
    await authorize();
    if (await read(RETIRED, `${key(run, task)}/${holder}`))
      throw new Error('GitHub lease generation has already been released');
    const current = await read<GithubTaskLease>(LEASES, key(run, task));
    if (current) {
      if (current.holder !== holder) throw new Error('Task already has a GitHub lease');
      return current;
    }
    // Legacy runs have no per-task lease protocol. Drain them before sharing this catalog's pool.
    const owningRun = await read<{ catalog: string }>('@workspace-run', run);
    for (const id of await getCredentialBindingDao().listUsernames('@workspace-run')) {
      const legacy = await read<{ catalog: string; githubPool?: GithubPoolSnapshot }>(
        '@workspace-run',
        id,
      );
      if (legacy && legacy.catalog === owningRun?.catalog && !legacy.githubPool?.accounts.length)
        return undefined;
    }
    const occupied = new Set<string>();
    for (const id of await getCredentialBindingDao().listUsernames(LEASES)) {
      const lease = await read<GithubTaskLease>(LEASES, id);
      if (lease) occupied.add(lease.account.id);
    }
    const cursorKey = owningRun?.catalog || 'shared';
    const last = await read<string>('@github-pool-cursor', cursorKey);
    const start =
      (snapshot.accounts.findIndex((account) => account.id === last) + 1) %
      snapshot.accounts.length;
    for (let offset = 0; offset < snapshot.accounts.length; offset++) {
      const account = snapshot.accounts[(start + offset) % snapshot.accounts.length];
      if (occupied.has(account.id)) continue;
      if (((await githubThrottleStore.load(account.id))?.cooldownUntil || 0) > Date.now()) continue;
      const lease = { run, task, holder, account };
      await write(LEASES, key(run, task), lease);
      await write('@github-pool-cursor', cursorKey, account.id);
      return lease;
    }
    return undefined;
  });
}
export async function githubTaskAccount(run: string, task: string, holder: string) {
  const lease = await read<GithubTaskLease>(LEASES, key(run, task));
  if (!holder || !lease || lease.holder !== holder)
    throw new Error('GitHub task lease unavailable');
  return lease.account;
}
export function releaseGithubTask(
  run: string,
  task: string,
  holder: string,
  authorize: () => Promise<unknown>,
) {
  return withGithubTaskPreparationCleanup(run, task, (clear) =>
    serial(async () => {
      await authorize();
      const lease = await read<GithubTaskLease>(LEASES, key(run, task));
      if (lease && lease.holder !== holder) throw new Error('GitHub task lease mismatch');
      await write(RETIRED, `${key(run, task)}/${holder}`, { run });
      // The caller confirmed container removal. Clear only this task's initializer,
      // before the account becomes available to another task. Failure retains the lease.
      if (lease) await clear(lease.account.id);
      await getCredentialBindingDao().delete({ serverName: LEASES, username: key(run, task) });
    }),
  );
}
export function releaseGithubTasks(run: string, finish: () => Promise<void>) {
  return serial(async () => {
    // Delete the owning run first so an admission waiting on this queue cannot re-acquire.
    await finish();
    for (const id of await getCredentialBindingDao().listUsernames(RETIRED)) {
      if ((await read<{ run: string }>(RETIRED, id))?.run === run)
        await getCredentialBindingDao().delete({ serverName: RETIRED, username: id });
    }
    for (const id of await getCredentialBindingDao().listUsernames(LEASES)) {
      const lease = await read<GithubTaskLease>(LEASES, id);
      if (lease?.run === run)
        await getCredentialBindingDao().delete({ serverName: LEASES, username: id });
    }
  });
}
