import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

type Entry = { line: Buffer; resolve: () => void; reject: (error: unknown) => void };
const pending = new Map<string, Entry[]>();
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_BATCH_RECORDS = 128;

/** Group concurrent records into one durable write; callers still await fsync. */
async function drain(file: string, queue: Entry[]): Promise<void> {
  while (queue.length) {
    const batch: Entry[] = [];
    let bytes = 0;
    while (queue.length && batch.length < MAX_BATCH_RECORDS) {
      if (batch.length && bytes + queue[0].line.length > MAX_BATCH_BYTES) break;
      const entry = queue.shift()!;
      batch.push(entry);
      bytes += entry.line.length;
    }
    try {
      const directory = dirname(file);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(file, 'a', 0o600);
      try {
        await handle.writeFile(
          Buffer.concat(
            batch.map((entry) => entry.line),
            bytes,
          ),
        );
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
      for (const entry of batch) entry.resolve();
    } catch (error) {
      // Reject all affected admissions; later batches can recover independently.
      for (const entry of batch) entry.reject(error);
    }
  }
  pending.delete(file);
}

export function appendDurableAudit(file: string, record: unknown): Promise<void> {
  const line = Buffer.from(`${JSON.stringify(record)}\n`);
  return new Promise<void>((resolve, reject) => {
    let queue = pending.get(file);
    if (!queue) {
      queue = [];
      pending.set(file, queue);
      const active = queue;
      // Collect this event-loop turn, without a fixed batching timer.
      setImmediate(() => {
        void drain(file, active);
      });
    }
    queue.push({ line, resolve, reject });
  });
}
