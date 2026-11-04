import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

const pending = new Map<string, Promise<void>>();

/** Serialize complete JSONL records without blocking the HTTP event loop on fsync. */
export function appendDurableAudit(file: string, record: unknown): Promise<void> {
  const line = Buffer.from(`${JSON.stringify(record)}\n`);
  const write = async () => {
    const directory = dirname(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(file, 'a', 0o600);
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (const path of [directory, dirname(directory)]) {
      const handle = await open(path, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  };
  // A failed request must not poison subsequent admissions after storage recovers.
  const result = (pending.get(file) ?? Promise.resolve()).then(write, write);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pending.set(file, settled);
  void settled.then(() => {
    if (pending.get(file) === settled) pending.delete(file);
  });
  return result;
}
