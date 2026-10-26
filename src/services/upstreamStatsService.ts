import { usageLogDirectories, matchesLogScope } from './usageLogDirectories.js';
import { splitServerKey } from '../utils/catalog.js';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { keyPoolLogDirectory } from './keyPoolService.js';
import type { ServerCallStats, StatsQuery } from './callStatsService.js';

/** Complete upstream attempts only. One HTTP attempt may carry multiple credential roles. */
export async function getUpstreamStats(query: StatsQuery) {
  const groups = new Map<string, ServerCallStats>();
  const seen = new Set<string>();
  const unavailableSources: string[] = [];
  const recordedServers = new Set<string>();
  const aliases: Record<string, string> = {
    brave: 'brave-search',
    weatherapi: 'weather-data',
    lara: 'lara-translate',
  };
  const add = (
    source: string,
    value: Record<string, unknown>,
    identity?: { server?: string; catalog: string },
  ) => {
    const timestamp = Date.parse(String(value.ts || ''));
    if (
      !Number.isFinite(timestamp) ||
      timestamp < Date.parse(query.start) ||
      timestamp > Date.parse(query.end)
    )
      return;
    const rawServer = String(value.server || value.service || 'unknown');
    const server =
      identity?.server || (source === 'mcp' ? aliases[rawServer] || rawServer : rawServer);
    const catalog = identity?.catalog ?? splitServerKey(server).catalog;
    recordedServers.add(server);
    if (!matchesLogScope(server, query, catalog)) return;
    let ids = [String(value.credential_id || '')];
    if (source === 'http') {
      try {
        const credentials = JSON.parse(String(value.upstream_credentials || '[]')) as {
          id?: string;
        }[];
        if (!Array.isArray(credentials)) return;
        ids = credentials.map((item) => String(item?.id || ''));
      } catch {
        return;
      }
    }
    if (query.credentialId && !ids.includes(query.credentialId)) return;
    const id = String(source === 'http' ? value.upstream_request_id || '' : value.request_id || '');
    if (!id || seen.has(`${source}:${catalog}:${server}:${id}`)) return;
    seen.add(`${source}:${catalog}:${server}:${id}`);
    const status = Number(value.http_status ?? value.status);
    const failed =
      value.outcome === 'error' ||
      value.status === 'error' ||
      !!value.error ||
      (Number.isFinite(status) && (status >= 400 || status === 0));
    const groupKey = `${catalog}:${server}`;
    const row = groups.get(groupKey) || {
      server,
      catalog,
      calls: 0,
      success: 0,
      errors: 0,
      durationMs: 0,
    };
    row.calls++;
    if (failed) row.errors++;
    else row.success++;
    if (typeof value.duration_ms === 'number' && Number.isFinite(value.duration_ms))
      row.durationMs += value.duration_ms;
    groups.set(groupKey, row);
  };
  const scan = async (
    directory: string,
    source: string,
    select: (file: string) => boolean,
    event: string,
    identity?: { server?: string; catalog: string },
  ) => {
    const streamFile = async (file: string) => {
      const stream = createReadStream(join(directory, file), { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let value;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          if (value && typeof value === 'object' && value.event === event)
            add(source, value, identity);
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    };
    try {
      for (const file of (await readdir(directory)).filter(select)) await streamFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailableSources.push(source);
    }
  };
  const firstDay = new Date(Date.parse(query.start) - 86400000).toISOString().slice(0, 10);
  const lastDay = query.end.slice(0, 10);
  const daily = (file: string) =>
    /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) &&
    file.slice(0, 10) >= firstDay &&
    file.slice(0, 10) <= lastDay;
  if (process.env.MCPHUB_AUDIT_LOG_DIR)
    await scan(process.env.MCPHUB_AUDIT_LOG_DIR, 'http', daily, 'upstream_finished');
  else unavailableSources.push('http');
  await scan(keyPoolLogDirectory(), 'key_pool', daily, 'finished');
  const usage = process.env.MCP_USAGE_LOG_DIR;
  if (usage) {
    try {
      for (const identity of await usageLogDirectories(usage)) {
        for (const month of await readdir(identity.directory)) {
          if (
            !/^\d{4}-\d{2}$/.test(month) ||
            month < firstDay.slice(0, 7) ||
            month > lastDay.slice(0, 7)
          )
            continue;
          await scan(
            join(identity.directory, month),
            'mcp',
            (file) => /_\d{8}\.jsonl$/.test(file),
            'finished',
            identity,
          );
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailableSources.push('mcp');
    }
  } else unavailableSources.push('mcp');
  const rows = [...groups.values()].sort((a, b) => b.calls - a.calls);
  return {
    rows,
    total: rows.reduce((n, r) => n + r.calls, 0),
    success: rows.reduce((n, r) => n + r.success, 0),
    errors: rows.reduce((n, r) => n + r.errors, 0),
    available: unavailableSources.length < 3,
    metric: 'upstream',
    partialCoverage: true,
    recordedServers: [...recordedServers].sort(),
    unavailableSources,
  };
}
