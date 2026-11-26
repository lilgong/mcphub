import { calendarDate } from '../utils/calendarTime.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { splitServerKey } from '../utils/catalog.js';
import { matchesStatsScope, usageLogDirectories } from './usageLogDirectories.js';
import type { StatsQuery, ServerCallStats } from './callStatsService.js';
import type { UpstreamKeyStats } from './upstreamStatsService.js';

interface MonthIndex {
  version: 1;
  seen: string[];
  days: Record<
    string,
    { servers: Record<string, ServerCallStats>; keys: Record<string, UpstreamKeyStats> }
  >;
}
interface Cursor {
  inode: number;
  size: number;
  mtime: number;
  offset: number;
}
const pending = new Map<string, Promise<unknown>>();
const aliases: Record<string, string> = {
  brave: 'brave-search',
  weatherapi: 'weather-data',
  lara: 'lara-translate',
  exa: 'exa',
  oxylabs: 'oxylabs',
};

function directory() {
  const audit = process.env.MCPHUB_AUDIT_LOG_DIR;
  return (
    process.env.MCPHUB_USAGE_STATS_DIR ||
    (audit ? join(dirname(audit), 'usage-statistics', 'yibu') : undefined)
  );
}
async function json<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}
async function save(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

async function ingest(root: string, timeZone: string): Promise<string[]> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const suffixPath = join(root, 'key-suffixes.json');
  const storedSuffixes = await json<Record<string, string> | null>(suffixPath, null);
  const knownSuffixes: Record<string, string> = storedSuffixes || {};
  let suffixesChanged = storedSuffixes === null;
  const rememberSuffix = (id: string, suffix: string | undefined) => {
    if (/^[a-f0-9]{16}$/.test(id) && suffix && !knownSuffixes[id]) {
      knownSuffixes[id] = suffix.slice(-4);
      suffixesChanged = true;
    }
  };
  // Bootstrap labels from all historical summaries, independent of date and MCP filters.
  if (storedSuffixes === null) {
    for (const file of (await readdir(root)).filter((name) => /^\d{4}-\d{2}\.json$/.test(name))) {
      const index = await json<MonthIndex>(join(root, file), { version: 1, seen: [], days: {} });
      for (const bucket of Object.values(index.days))
        for (const row of Object.values(bucket.keys))
          rememberSuffix(row.credentialId, row.credentialSuffix);
    }
  }
  const cursors = await json<Record<string, Cursor>>(join(root, 'cursors.json'), {});
  const months = new Map<string, { index: MonthIndex; seen: Set<string> }>();
  const unavailable = new Set<string>();
  const month = async (name: string) => {
    let value = months.get(name);
    if (!value) {
      const index = await json<MonthIndex>(join(root, `${name}.json`), {
        version: 1,
        seen: [],
        days: {},
      });
      value = { index, seen: new Set(index.seen) };
      months.set(name, value);
    }
    return value;
  };
  const add = async (
    value: Record<string, unknown>,
    source: 'http' | 'mcp',
    identity?: { server?: string; catalog: string },
  ) => {
    if (value.event !== (source === 'http' ? 'upstream_finished' : 'finished')) return;
    const rawService = String(value.service || '');
    // HTTP resources can have arbitrary registration names. Use the actual upstream host.
    if (source === 'http' && !/(^|\.)yibuapi\.com$/i.test(String(value.upstream_host || '')))
      return;
    if (source === 'mcp' && !aliases[rawService]) return;
    const server = identity?.server || String(value.server || aliases[rawService] || '');
    const catalog = identity?.catalog ?? splitServerKey(server).catalog;
    const timestamp = Date.parse(String(value.ts || ''));
    const request = String(
      source === 'http' ? value.upstream_request_id || '' : value.request_id || '',
    );
    if (!server || !request || !Number.isFinite(timestamp)) return;
    const date = calendarDate(timestamp, timeZone);
    const bucket = await month(date.slice(0, 7));
    const id = createHash('sha256')
      .update(JSON.stringify([source, catalog, server, request]))
      .digest('hex');
    if (bucket.seen.has(id)) return;
    let credentials: { id: string; suffix?: string }[] = [];
    if (source === 'http') {
      try {
        const parsed = JSON.parse(String(value.upstream_credentials || '[]'));
        if (Array.isArray(parsed)) credentials = parsed;
      } catch {
        /* Keep requests lacking credential metadata in an explicit unknown bucket. */
      }
    } else
      credentials = [
        { id: String(value.credential_id || ''), suffix: String(value.credential_suffix || '') },
      ];
    credentials = [
      ...new Map(
        credentials.map((item) => {
          const id = /^[a-f0-9]{16}$/.test(String(item?.id || '')) ? String(item.id) : '';
          return [id, { id, suffix: id ? String(item?.suffix || '').slice(-4) : '' }];
        }),
      ).values(),
    ];
    if (!credentials.length) credentials = [{ id: '' }];
    for (const credential of credentials) rememberSuffix(credential.id, credential.suffix);
    const status = Number(value.http_status ?? value.status);
    const failed =
      value.outcome === 'error' ||
      value.status === 'error' ||
      !!value.error ||
      (Number.isFinite(status) && (status >= 400 || status === 0));
    const durationMs =
      typeof value.duration_ms === 'number' && Number.isFinite(value.duration_ms)
        ? value.duration_ms
        : 0;
    const day = (bucket.index.days[date] ||= { servers: {}, keys: {} });
    const update = (row: ServerCallStats) => {
      row.calls++;
      row[failed ? 'errors' : 'success']++;
      row.durationMs += durationMs;
    };
    const serverKey = JSON.stringify([catalog, server]);
    update(
      (day.servers[serverKey] ||= {
        server,
        catalog,
        calls: 0,
        success: 0,
        errors: 0,
        durationMs: 0,
      }),
    );
    for (const credential of credentials) {
      const key = JSON.stringify([catalog, server, credential.id]);
      update(
        (day.keys[key] ||= {
          server,
          catalog,
          credentialId: credential.id,
          credentialSuffix: credential.suffix || undefined,
          calls: 0,
          success: 0,
          errors: 0,
          durationMs: 0,
        }),
      );
    }
    bucket.seen.add(id);
  };
  const scan = async (
    path: string,
    source: 'http' | 'mcp',
    identity?: { server?: string; catalog: string },
  ) => {
    const info = await stat(path);
    const old = cursors[path];
    if (old && old.inode === info.ino && old.size === info.size && old.mtime === info.mtimeMs)
      return;
    let offset = old && old.inode === info.ino && info.size > old.size ? old.offset : 0;
    let tail = Buffer.alloc(0);
    if (offset < info.size) {
      for await (const chunk of createReadStream(path, { start: offset, end: info.size - 1 })) {
        const buffer = Buffer.concat([tail, chunk as Buffer]);
        let start = 0;
        let newline: number;
        while ((newline = buffer.indexOf(10, start)) >= 0) {
          let value: unknown;
          try {
            value = JSON.parse(buffer.subarray(start, newline).toString('utf8'));
          } catch {
            /* A damaged complete line does not invalidate other records. */
          }
          if (value && typeof value === 'object')
            await add(value as Record<string, unknown>, source, identity);
          offset += newline - start + 1;
          start = newline + 1;
        }
        tail = buffer.subarray(start);
      }
    }
    cursors[path] = { inode: info.ino, size: info.size, mtime: info.mtimeMs, offset };
  };
  const scanDirectory = async (
    path: string,
    source: 'http' | 'mcp',
    pattern: RegExp,
    identity?: { server?: string; catalog: string },
  ) => {
    try {
      for (const file of (await readdir(path)).filter((file) => pattern.test(file)))
        await scan(join(path, file), source, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  const audit = process.env.MCPHUB_AUDIT_LOG_DIR;
  if (audit) await scanDirectory(audit, 'http', /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  else unavailable.add('http');
  const usage = process.env.MCP_USAGE_LOG_DIR;
  if (usage) {
    for (const identity of await usageLogDirectories(usage)) {
      let files: string[];
      try {
        files = await readdir(identity.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const name of files.filter((name) => /^\d{4}-\d{2}$/.test(name)))
        await scanDirectory(join(identity.directory, name), 'mcp', /_\d{8}\.jsonl$/, identity);
    }
  } else unavailable.add('mcp');
  // Commit summaries before source offsets: interruption can replay, but cannot skip accounting.
  for (const [name, bucket] of months) {
    bucket.index.seen = [...bucket.seen];
    await save(join(root, `${name}.json`), bucket.index);
  }
  if (suffixesChanged) await save(suffixPath, knownSuffixes);
  await save(join(root, 'cursors.json'), cursors);
  return [...unavailable];
}

/** Persistent daily rollups supply monthly and date-range totals without rescanning history. */
export async function getYibuStats(query: StatsQuery, suffixes: Map<string, string> = new Map()) {
  const base = directory();
  const root =
    base && query.timeZone && query.timeZone !== 'UTC'
      ? join(base, 'timezones', Buffer.from(query.timeZone).toString('base64url'))
      : base;
  if (!root)
    return {
      rows: [],
      keyRows: [],
      total: 0,
      success: 0,
      errors: 0,
      available: false,
      metric: 'yibu',
    };
  const previous = pending.get(root) || Promise.resolve();
  const task = previous.catch(() => undefined).then(() => readYibuStats(root, query, suffixes));
  pending.set(root, task);
  try {
    return await task;
  } finally {
    if (pending.get(root) === task) pending.delete(root);
  }
}

async function readYibuStats(root: string, query: StatsQuery, suffixes: Map<string, string>) {
  const timeZone = query.timeZone || 'UTC';
  const firstDay = calendarDate(query.start, timeZone);
  const lastDay = calendarDate(query.end, timeZone);
  const unavailableSources = await ingest(root, timeZone);
  const suffixPath = join(root, 'key-suffixes.json');
  const knownSuffixes = await json<Record<string, string>>(suffixPath, {});
  let suffixesChanged = false;
  for (const [id, suffix] of suffixes) {
    if (!knownSuffixes[id] && /^[a-f0-9]{16}$/.test(id) && suffix) {
      knownSuffixes[id] = suffix.slice(-4);
      suffixesChanged = true;
    }
  }
  if (suffixesChanged) await save(suffixPath, knownSuffixes);
  const keys = new Map<string, UpstreamKeyStats>();
  const servers = new Map<string, ServerCallStats>();
  const merge = <T extends ServerCallStats>(map: Map<string, T>, key: string, row: T) => {
    const old = map.get(key);
    if (old) {
      old.calls += row.calls;
      old.success += row.success;
      old.errors += row.errors;
      old.durationMs += row.durationMs;
    } else map.set(key, { ...row });
  };
  for (const file of (await readdir(root)).filter(
    (file) =>
      /^\d{4}-\d{2}\.json$/.test(file) &&
      file.slice(0, 7) >= firstDay.slice(0, 7) &&
      file.slice(0, 7) <= lastDay.slice(0, 7),
  )) {
    const index = await json<MonthIndex>(join(root, file), { version: 1, seen: [], days: {} });
    let enriched = false;
    for (const bucket of Object.values(index.days)) {
      for (const row of Object.values(bucket.keys)) {
        const suffix = knownSuffixes[row.credentialId];
        if (!row.credentialSuffix && suffix) {
          row.credentialSuffix = suffix;
          enriched = true;
        }
      }
    }
    if (enriched) await save(join(root, file), index);
    for (const [day, bucket] of Object.entries(index.days)) {
      if (day < firstDay || day > lastDay) continue;
      if (query.credentialId) {
        for (const row of Object.values(bucket.keys)) {
          if (
            row.credentialId !== query.credentialId ||
            !matchesStatsScope(row.server, query, row.catalog)
          )
            continue;
          merge(keys, JSON.stringify([row.catalog, row.server, row.credentialId]), row);
          merge(servers, JSON.stringify([row.catalog, row.server]), row);
        }
      } else {
        for (const row of Object.values(bucket.servers))
          if (matchesStatsScope(row.server, query, row.catalog))
            merge(servers, JSON.stringify([row.catalog, row.server]), row);
        for (const row of Object.values(bucket.keys))
          if (matchesStatsScope(row.server, query, row.catalog))
            merge(keys, JSON.stringify([row.catalog, row.server, row.credentialId]), row);
      }
    }
  }
  const rows = [...servers.values()].sort((a, b) => b.calls - a.calls);
  return {
    rows,
    keyRows: [...keys.values()].sort((a, b) => b.calls - a.calls),
    total: rows.reduce((sum, row) => sum + row.calls, 0),
    success: rows.reduce((sum, row) => sum + row.success, 0),
    errors: rows.reduce((sum, row) => sum + row.errors, 0),
    available: true,
    metric: 'yibu',
    unavailableSources,
  };
}
