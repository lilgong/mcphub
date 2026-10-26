import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { splitServerKey } from '../utils/catalog.js';
import { keyPoolLogDirectory } from './keyPoolService.js';
import { usageLogDirectories } from './usageLogDirectories.js';

const CATALOG = /^[a-z][a-z0-9_-]{0,47}$/;
const TTL_MS = 30_000;
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
    const names = new Set<string>();
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
      const stream = createReadStream(path, { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          if (!record || !events.includes(String(record.event))) continue;
          if (catalog !== undefined) add(catalog);
          else {
            // Root MCP audit records can identify their canonical registration
            // through group rather than server, matching the statistics reader.
            const server =
              typeof record.server === 'string' && record.server
                ? record.server
                : typeof record.group === 'string'
                  ? record.group
                  : '';
            add(splitServerKey(server).catalog || record.catalog);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
      } finally {
        lines.close();
        stream.destroy();
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
    // Do not turn transient read failures into a cached empty history.
    if (complete) cache = { key, until: Date.now() + TTL_MS, names: result };
    return result;
  };
  const result = scan();
  pending = { key, result };
  try {
    return [...(await result)];
  } finally {
    if (pending?.result === result) pending = undefined;
  }
}
