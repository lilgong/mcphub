import { getCredentialBindingDao } from '../dao/DaoFactory.js';
import { decryptCredentialValues, encryptCredentialValues } from './credentialBindingService.js';

const KIND = '@github-preparation';
interface Claim {
  run: string;
  task: string;
  holder: string;
}
let pending: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation, operation);
  pending = result.catch(() => undefined);
  return result;
}
async function read(account: string): Promise<Claim | undefined> {
  const record = await getCredentialBindingDao().get(KIND, account);
  return record ? JSON.parse((await decryptCredentialValues(record)).payload) : undefined;
}
export function githubPreparation(
  account: string,
  claim: Claim,
  release = false,
  authorize?: () => Promise<unknown>,
): Promise<boolean> {
  return serial(async () => {
    await authorize?.();
    const current = await read(account);
    const own =
      current?.run === claim.run &&
      current?.task === claim.task &&
      current?.holder === claim.holder;
    if (release) {
      if (own) await getCredentialBindingDao().delete({ serverName: KIND, username: account });
      return !current || own;
    }
    if (current) return own;
    await getCredentialBindingDao().save({
      serverName: KIND,
      username: account,
      encryptedValues: await encryptCredentialValues(KIND, account, {
        payload: JSON.stringify(claim),
      }),
      updatedAt: new Date().toISOString(),
    });
    return true;
  });
}
/** Keep the preparation -> pool lock order used by whole-run cleanup. */
export function withGithubTaskPreparationCleanup<T>(
  run: string,
  task: string,
  release: (clear: (account: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  return serial(() =>
    release(async (account) => {
      const current = await read(account);
      if (current?.run === run && current.task === task)
        await getCredentialBindingDao().delete({ serverName: KIND, username: account });
    }),
  );
}
/** A lost initializer stays reserved until its owning run has finished cleanup. */
export function releaseGithubPreparations(run: string, finish: () => Promise<void>): Promise<void> {
  return serial(async () => {
    for (const account of await getCredentialBindingDao().listUsernames(KIND)) {
      if ((await read(account))?.run === run)
        await getCredentialBindingDao().delete({ serverName: KIND, username: account });
    }
    await finish();
  });
}
