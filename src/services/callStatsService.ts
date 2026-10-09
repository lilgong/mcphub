import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
export type StatsGrouping = 'server' | 'target' | 'model' | 'benchmark' | 'all';
export interface StatsQuery {
  groupBy?: StatsGrouping;
  start: string;
  end: string;
  server?: string;
  target?: string;
  model?: string;
  benchmark?: string;
}
export interface ServerCallStats {
  server: string;
  target: string;
  model: string;
  benchmark: string;
  calls: number;
  success: number;
  errors: number;
  durationMs: number;
}
/** Stream complete tool audit files; HTTP attempts and diagnostic events are never counted as extra calls. */
export async function getCallStats(query: StatsQuery): Promise<{
  rows: ServerCallStats[];
  total: number;
  success: number;
  errors: number;
  available: boolean;
}> {
  const directory = process.env.MCPHUB_AUDIT_LOG_DIR;
  if (!directory) return { rows: [], total: 0, success: 0, errors: 0, available: false };
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') files = [];
    else throw error;
  }
  const groups = new Map<string, ServerCallStats>();
  const previousDay = new Date(Date.parse(query.start) - 86400000).toISOString().slice(0, 10);
  for (const file of files.filter(
    (name) =>
      /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) &&
      name.slice(0, 10) >= previousDay &&
      name.slice(0, 10) <= query.end.slice(0, 10),
  )) {
    const calls = new Map<string, string>();
    const finished = new Set<string>();
    const stream = createReadStream(join(directory, file), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (!value || typeof value !== 'object') continue;
        const text = (key: string) =>
          typeof value[key] === 'string' ? (value[key] as string) : '';
        const id = text('request_id');
        if (text('server')) calls.set(id, text('server'));
        if (value.event !== 'finished' || finished.has(id)) continue;
        finished.add(id);
        const server = text('server') || calls.get(id) || text('group') || 'unknown';
        calls.delete(id);
        const ts = text('ts');
        const target = text('target'),
          model = text('model'),
          benchmark = text('benchmark');
        if (
          ts < query.start ||
          ts > query.end ||
          (query.server && server !== query.server) ||
          (query.target && target !== query.target) ||
          (query.model && model !== query.model) ||
          (query.benchmark && benchmark !== query.benchmark)
        )
          continue;
        const dimensions = { target: '', model: '', benchmark: '' };
        for (const field of ['target', 'model', 'benchmark'] as const) {
          if (query.groupBy === 'all' || query.groupBy === field)
            dimensions[field] = { target, model, benchmark }[field];
        }
        const key = JSON.stringify([
          server,
          dimensions.target,
          dimensions.model,
          dimensions.benchmark,
        ]);
        const row = groups.get(key) || {
          server,
          ...dimensions,
          calls: 0,
          success: 0,
          errors: 0,
          durationMs: 0,
        };
        row.calls++;
        if (value.status === 'error') row.errors++;
        else row.success++;
        if (typeof value.duration_ms === 'number' && Number.isFinite(value.duration_ms))
          row.durationMs += value.duration_ms;
        groups.set(key, row);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
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
