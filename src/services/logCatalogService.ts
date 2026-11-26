import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { splitServerKey } from '../utils/catalog.js';
import { keyPoolLogDirectory } from './keyPoolService.js';
import { usageLogDirectories } from './usageLogDirectories.js';

const CATALOG = /^[a-z][a-z0-9_-]{0,47}$/;
const TTL_MS = 30_000;
interface HistoryIndex {
  version: 1;
  names: string[];
  files: Record<string, { inode: number; size: number; mtime: number; offset: number }>;
}
let cache: { key: string; until: number; names: string[] } | undefined;
let pending: { key: string; result: Promise<string[]> } | undefined;

/** Log-only discovery: deleted registrations must remain selectable in history. */
export async function historicalLogCatalogs(registrationRevision = ''): Promise<string[]> {
  const audit = process.env.MCPHUB_AUDIT_LOG_DIR;
  const pool = keyPoolLogDirectory();
  const usage = process.env.MCP_USAGE_LOG_DIR;
  const relay = process.env.MCPHUB_RELAY_LOG_FILE;
  const key = JSON.stringify([audit, pool, usage, relay, registrationRevision]);
  if (cache?.key === key && Date.now() < cache.until) return [...cache.names];
  if (pending?.key === key) return [...(await pending.result)];

  const scan = async () => {
    const source = JSON.stringify([audit, pool, usage, relay]);
    const indexPath = join(
      dirname(resolve(audit || pool || relay || join(usage || 'data', 'audit'))),
      'usage-statistics',
      'log-catalogs',
      createHash('sha256').update(source).digest('hex').slice(0, 16) + '.json',
    );
    let index: HistoryIndex = { version: 1, names: [], files: {} };
    try {
      const stored = JSON.parse(await readFile(indexPath, 'utf8')) as HistoryIndex;
      if (stored.version === 1 && Array.isArray(stored.names) && stored.files) index = stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const names = new Set<string>(index.names.filter((name) => CATALOG.test(name)));
    let changed = false;
    let complete = true;
    const add = (name: unknown) => {
      if (typeof name === 'string' && CATALOG.test(name)) names.add(name);
    };
    const children = async (path: string) => {
      try {
        return await readdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
        return [];
      }
    };
    const read = async (path: string, events: string[], catalog?: string) => {
      let stream: ReturnType<typeof createReadStream> | undefined;
      try {
        const info = await stat(path);
        const previous = index.files[path];
        if (
          previous?.inode === info.ino &&
          previous.size === info.size &&
          previous.mtime === info.mtimeMs
        )
          return;
        const start =
          previous?.inode === info.ino &&
          info.size >= previous.size &&
          (info.size !== previous.size || info.mtimeMs === previous.mtime)
            ? previous.offset
            : 0;
        let offset = start;
        let tail = Buffer.alloc(0);
        if (info.size > start) {
          stream = createReadStream(path, { start, end: info.size - 1 });
          for await (const chunk of stream) {
            const bytes = Buffer.concat([tail, Buffer.from(chunk)]);
            let cursor = 0;
            for (
              let newline = bytes.indexOf(10);
              newline >= 0;
              newline = bytes.indexOf(10, cursor)
            ) {
              const line = bytes.subarray(cursor, newline).toString('utf8');
              offset += newline + 1 - cursor;
              cursor = newline + 1;
              let record: Record<string, unknown>;
              try {
                record = JSON.parse(line);
              } catch {
                continue;
              }
              if (!record || !events.includes(String(record.event))) continue;
              if (catalog !== undefined) add(catalog);
              else {
                const server =
                  typeof record.server === 'string' && record.server
                    ? record.server
                    : typeof record.group === 'string'
                      ? record.group
                      : '';
                add(splitServerKey(server).catalog || record.catalog);
              }
            }
            tail = Buffer.from(bytes.subarray(cursor));
            // History discovery must not monopolize the tool-serving event loop.
            await new Promise<void>((done) => setImmediate(done));
          }
        }
        index.files[path] = { inode: info.ino, size: info.size, mtime: info.mtimeMs, offset };
        changed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
      } finally {
        stream?.destroy();
      }
    };
    for (const directory of [audit, pool]) {
      if (!directory) continue;
      for (const file of await children(directory)) {
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
          await read(join(directory, file), ['finished', 'pool_unavailable', 'upstream_finished']);
      }
    }
    if (usage) {
      try {
        for (const identity of await usageLogDirectories(usage)) {
          if (!CATALOG.test(identity.catalog)) continue;
          for (const month of await children(identity.directory)) {
            if (!/^\d{4}-\d{2}$/.test(month)) continue;
            const directory = join(identity.directory, month);
            for (const file of await children(directory)) {
              if (/_\d{8}\.jsonl$/.test(file))
                await read(join(directory, file), ['finished'], identity.catalog);
            }
          }
        }
      } catch {
        complete = false;
      }
    }
    if (relay) await read(relay, ['http_finished', 'http_completed', 'request_rejected']);
    const result = [...names].sort();
    if (changed) {
      index.names = result;
      await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 });
      const temporary = indexPath + '.' + randomUUID() + '.tmp';
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(index));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, indexPath);
    }
    // Do not turn transient read failures into a cached empty history.
    if (complete) cache = { key, until: Date.now() + TTL_MS, names: result };
    return result;
  };
  const result = (pending?.result.catch(() => undefined) || Promise.resolve()).then(scan);
  pending = { key, result };
  try {
    return [...(await result)];
  } finally {
    if (pending?.result === result) pending = undefined;
  }
}
