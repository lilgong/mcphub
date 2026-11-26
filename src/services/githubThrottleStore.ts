import { getCredentialBindingDao } from '../dao/DaoFactory.js';
import { decryptCredentialValues, encryptCredentialValues } from './credentialBindingService.js';
export interface GithubThrottleState {
  cooldownUntil: number;
  nextWriteAt: number;
  failures: number;
}
export interface GithubThrottleStore {
  identity(key: string): Promise<string | undefined>;
  saveIdentity(key: string, account: string): Promise<void>;
  load(account: string): Promise<GithubThrottleState | undefined>;
  save(account: string, state: GithubThrottleState): Promise<void>;
}
const KIND = '@github-throttle';
async function read(id: string): Promise<unknown> {
  const record = await getCredentialBindingDao().get(KIND, id);
  return record ? JSON.parse((await decryptCredentialValues(record)).payload) : undefined;
}
async function write(id: string, payload: unknown) {
  await getCredentialBindingDao().save({
    serverName: KIND,
    username: id,
    encryptedValues: await encryptCredentialValues(KIND, id, { payload: JSON.stringify(payload) }),
    updatedAt: new Date().toISOString(),
  });
}
/** Hashed credential -> user ID and cooldown metadata only; no tokens or request payloads. */
export const githubThrottleStore: GithubThrottleStore = {
  async identity(key) {
    const value = await read('key/' + key);
    return typeof value === 'string' && /^[0-9]+$/.test(value) ? value : undefined;
  },
  saveIdentity: (key, account) => write('key/' + key, account),
  async load(account) {
    const value = (await read('account/' + account)) as GithubThrottleState | undefined;
    if (!value) return undefined;
    if (
      ![value.cooldownUntil, value.nextWriteAt, value.failures].every(
        (v) => Number.isFinite(v) && v >= 0,
      )
    )
      throw new Error('Invalid GitHub throttle state');
    return value;
  },
  save: (account, state) => write('account/' + account, state),
};
