import { cp, mkdir, readFile, rename, stat, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mcpbServerDirectoryName } from '../utils/mcpbPaths.js';
import type { WorkerLaunch } from '../clients/workerStdioTransport.js';

const copies = new Map<string, Promise<void>>();
/** Snapshot read-only uploaded code into immutable worker-owned releases. */
export async function prepareWorkerPackage(
  launch: WorkerLaunch,
  catalog: string,
): Promise<WorkerLaunch> {
  const directory = mcpbServerDirectoryName(launch.name);
  const configured = join('/app/data/uploads/mcpb/catalogs', catalog, directory);
  // Match the directory itself, children, and roots in path lists/quoted values.
  // A sibling such as "server-atlas~module-backup" is a different package.
  const escaped = configured.split('.').join('[.]');
  const references = new RegExp(escaped + `(?=$|[/:"' ])`, 'g');
  if (
    ![launch.command, ...launch.args, ...Object.values(launch.env)].some((value) =>
      value.match(references),
    )
  )
    return launch;
  const source = join(process.env.MCPHUB_WORKER_PACKAGES || '/app/packages', directory);
  const metadata = await stat(source);
  const manifest = await readFile(join(source, 'manifest.json'));
  const installation = await readFile(join(source, '.mcphub-install-id')).catch(() =>
    Buffer.alloc(0),
  );
  const revision = createHash('sha256')
    .update(`${metadata.ino}:${metadata.mtimeMs}:`)
    .update(manifest)
    .update(installation)
    .digest('hex');
  const destination = join(
    process.env.MCPHUB_WORKER_RELEASES || '/app/data/releases',
    directory,
    revision,
  );
  let pending = copies.get(destination);
  if (!pending) {
    pending = (async () => {
      try {
        await stat(join(destination, 'manifest.json'));
        return;
      } catch {
        /* New release. */
      }
      await mkdir(join(destination, '..'), { recursive: true });
      const temporary = destination + '.' + randomUUID();
      try {
        await cp(source, temporary, { recursive: true });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    })();
    copies.set(destination, pending);
    void pending.catch(() => copies.delete(destination));
  }
  await pending;
  const rewrite = (value: string) => value.replace(references, () => destination);
  return {
    ...launch,
    command: rewrite(launch.command),
    args: launch.args.map(rewrite),
    env: Object.fromEntries(
      Object.entries(launch.env).map(([key, value]) => [key, rewrite(value)]),
    ),
  };
}
