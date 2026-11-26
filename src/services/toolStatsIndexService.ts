import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { splitServerKey } from '../utils/catalog.js';
import { matchesStatsScope } from './usageLogDirectories.js';
import type { ServerCallStats, StatsQuery } from './callStatsService.js';

type Event = [timestamp: number, server: string, error: number, duration: number];
interface Index {
  version: 1;
  source: { inode: number; size: number; mtime: number; offset: number };
  seen: string[];
  pending: Record<string, string>;
  days: Record<string, Record<string, ServerCallStats>>;
  events: Event[];
}
type Summary = Pick<Index, 'version' | 'source' | 'days'>;
const pending = new Map<string, Promise<unknown>>();
// Metadata lookup prevents unchanged source logs from being opened on warm reads.
const cursors = new Map<string, Index['source']>();
const add = (groups: Map<string, ServerCallStats>, row: ServerCallStats) => {
  const old = groups.get(row.server);
  if (!old) groups.set(row.server, { ...row });
  else {
    old.calls += row.calls;
    old.success += row.success;
    old.errors += row.errors;
    old.durationMs += row.durationMs;
  }
};
async function load(path: string): Promise<Index | undefined> {
  try {
    const result = JSON.parse(await readFile(path, 'utf8')) as Index;
    if (result.version !== 1) throw new Error('Unsupported tool statistics index');
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
async function save(path: string, index: Index | Summary): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(index));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
function empty(): Index {
  return {
    version: 1,
    source: { inode: 0, size: 0, mtime: 0, offset: 0 },
    seen: [],
    pending: {},
    days: {},
    events: [],
  };
}
async function ingest(source: string, destination: string): Promise<void> {
  const info = await stat(source);
  let old = cursors.get(destination);
  let index: Index | undefined;
  if (!old) {
    index = await load(destination);
    old = index?.source;
  }
  if (old && old.inode === info.ino && old.size === info.size && old.mtime === info.mtimeMs) {
    cursors.set(destination, old);
    return;
  }
  index ||= await load(destination);
  // Appends resume at the last complete line. Replacement/truncation deliberately
  // rebuilds this source's snapshot, instead of adding its records a second time.
  if (!index || !old || old.inode !== info.ino || info.size <= old.size) index = empty();
  const seen = new Set(index.seen);
  const calls = new Map(Object.entries(index.pending));
  let offset = index.source.offset;
  let tail = Buffer.alloc(0);
  let sinceYield = 0;
  if (offset < info.size) {
    for await (const chunk of createReadStream(source, { start: offset, end: info.size - 1 })) {
      const buffer = Buffer.concat([tail, chunk as Buffer]);
      let start = 0;
      let newline: number;
      while ((newline = buffer.indexOf(10, start)) >= 0) {
        const line = buffer.subarray(start, newline).toString('utf8');
        offset += newline - start + 1;
        start = newline + 1;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        const value = record as Record<string, unknown>;
        const text = (name: string) =>
          typeof value[name] === 'string' ? (value[name] as string) : '';
        const id = text('request_id');
        if (seen.has(id)) continue;
        if (text('server')) calls.set(id, text('server'));
        if (value.event === 'finished') {
          seen.add(id);
          const server = text('server') || calls.get(id) || text('group') || 'unknown';
          calls.delete(id);
          const timestamp = Date.parse(text('ts'));
          if (Number.isFinite(timestamp)) {
            const error = value.status === 'error' ? 1 : 0;
            const duration =
              typeof value.duration_ms === 'number' && Number.isFinite(value.duration_ms)
                ? value.duration_ms
                : 0;
            const day = new Date(timestamp).toISOString().slice(0, 10);
            const rows = (index.days[day] ||= {});
            const key = JSON.stringify(server);
            const row = (rows[key] ||= {
              server,
              catalog: splitServerKey(server).catalog,
              calls: 0,
              success: 0,
              errors: 0,
              durationMs: 0,
            });
            row.calls++;
            row.errors += error;
            row.success += 1 - error;
            row.durationMs += duration;
            // Compact metadata only; no tool arguments, results, credentials or targets.
            // Boundary-day events retain exact arbitrary-range/local-time queries.
            index.events.push([timestamp, server, error, duration]);
          }
        }
        if (++sinceYield >= 1000) {
          sinceYield = 0;
          await yieldTurn();
        }
      }
      tail = buffer.subarray(start);
      await yieldTurn();
    }
  }
  index.seen = [...seen];
  index.pending = Object.fromEntries(calls);
  index.source = { inode: info.ino, size: info.size, mtime: info.mtimeMs, offset };
  // Summary and cursor commit together. A crash replays at most an unsaved batch.
  await save(destination, index);
  await save(destination + '.summary', { version: 1, source: index.source, days: index.days });
  cursors.set(destination, index.source);
}

async function readStats(directory: string, root: string, query: StatsQuery) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  let sources: string[];
  try {
    sources = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    sources = [];
  }
  // Import once independently of the filter so changing MCP/date never rescans
  // unchanged raw files. Keep source snapshots even if raw logs are archived.
  for (const name of sources.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort())
    await ingest(join(directory, name), join(root, name.replace('.jsonl', '.json')));
  const groups = new Map<string, ServerCallStats>();
  const start = Date.parse(query.start),
    end = Date.parse(query.end);
  for (const name of (await readdir(root)).filter((name) =>
    /^\d{4}-\d{2}-\d{2}\.json$/.test(name),
  )) {
    const path = join(root, name);
    let index: Index | undefined;
    let expected = cursors.get(path);
    if (!expected) {
      index = await load(path);
      if (!index) continue;
      expected = index.source;
      cursors.set(path, expected);
    }
    let summary: Summary | undefined;
    try {
      summary = JSON.parse(await readFile(path + '.summary', 'utf8')) as Summary;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // The large snapshot and tiny summary share the committed source cursor.
    // If interrupted between writes, regenerate the derived summary on read.
    if (
      !summary ||
      summary.version !== 1 ||
      JSON.stringify(summary.source) !== JSON.stringify(expected)
    ) {
      index ||= await load(path);
      if (!index) continue;
      summary = { version: 1, source: index.source, days: index.days };
      await save(path + '.summary', summary);
    }
    const boundary = new Set<string>();
    for (const [day, rows] of Object.entries(summary.days)) {
      const midnight = Date.parse(day);
      if (midnight > end || midnight + 86400000 <= start) continue;
      if (midnight >= start && midnight + 86400000 - 1 <= end) {
        for (const row of Object.values(rows))
          if (matchesStatsScope(row.server, query)) add(groups, row);
      } else boundary.add(day);
    }
    if (boundary.size) {
      index ||= await load(path);
      if (!index) continue;
      for (const [timestamp, server, error, duration] of index.events) {
        if (timestamp < start || timestamp > end || !matchesStatsScope(server, query)) continue;
        if (!boundary.has(new Date(timestamp).toISOString().slice(0, 10))) continue;
        add(groups, {
          server,
          catalog: splitServerKey(server).catalog,
          calls: 1,
          success: 1 - error,
          errors: error,
          durationMs: duration,
        });
      }
    }
    await yieldTurn();
  }
  const rows = [...groups.values()].sort((a, b) => b.calls - a.calls);
  return {
    rows,
    total: rows.reduce((n, row) => n + row.calls, 0),
    success: rows.reduce((n, row) => n + row.success, 0),
    errors: rows.reduce((n, row) => n + row.errors, 0),
    available: true,
  };
}

/** On-demand incremental indexing; no synchronous audit-path work is added. */
export async function indexedToolStats(directory: string, query: StatsQuery) {
  const source = resolve(directory);
  const root = join(
    process.env.MCPHUB_TOOL_STATS_DIR || join(dirname(source), 'usage-statistics', 'tool'),
    createHash('sha256').update(source).digest('hex').slice(0, 16),
  );
  const previous = pending.get(root) || Promise.resolve();
  const task = previous.catch(() => undefined).then(() => readStats(source, root, query));
  pending.set(root, task);
  try {
    return await task;
  } finally {
    if (pending.get(root) === task) pending.delete(root);
  }
}
