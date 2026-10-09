import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { keyPoolLogDirectory } from './keyPoolService.js';

export interface CallLog {
  id: string;
  timestamp: string;
  source: 'tool' | 'yibu' | 'relay' | 'key_pool';
  target?: string;
  taskId?: string;
  keyLabel?: string;
  retryAt?: string;
  server: string;
  operation: string;
  outcome: 'success' | 'error';
  httpStatus?: number;
  category?: string;
  durationMs?: number;
  waitMs?: number;
  attempts?: number;
}
export interface CallLogQuery {
  date: string;
  status: string;
  errorsOnly: boolean;
  source: string;
  server: string;
  page: number;
  limit: number;
}

// Read bounded tails, never follow a caller-supplied path or return raw audit payloads.
export async function readAuditTail(
  path: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<{ records: Record<string, unknown>[]; truncated: boolean }> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { records: [], truncated: false };
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    const records: Record<string, unknown>[] = [];
    for (const line of text.split('\n')) {
      try {
        const item: unknown = JSON.parse(line);
        if (item && typeof item === 'object' && !Array.isArray(item))
          records.push(item as Record<string, unknown>);
      } catch {
        /* A concurrent append can leave the last record incomplete. */
      }
    }
    return { records, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}
const safeString = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, 512) : '';
const safeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export function matchesCallLog(row: CallLog, query: CallLogQuery): boolean {
  if (!row.timestamp.startsWith(query.date)) return false;
  if (query.errorsOnly && row.outcome !== 'error') return false;
  if (query.source !== 'all' && row.source !== query.source) return false;
  if (query.server && !row.server.toLowerCase().includes(query.server.toLowerCase())) return false;
  if (query.status === 'all') return true;
  if (query.status === 'none') return row.httpStatus === undefined;
  if (query.status === '4xx')
    return row.httpStatus !== undefined && row.httpStatus >= 400 && row.httpStatus < 500;
  if (query.status === '5xx') return row.httpStatus !== undefined && row.httpStatus >= 500;
  return row.httpStatus === Number(query.status);
}

export async function getCallLogs(
  query: CallLogQuery,
): Promise<{ rows: CallLog[]; total: number; truncated: boolean; unavailableSources: string[] }> {
  const rows: CallLog[] = [];
  let truncated = false;
  const unavailableSources: string[] = [];
  const load = async (path: string) => {
    const result = await readAuditTail(path, 4 * 1024 * 1024);
    truncated ||= result.truncated;
    return result.records;
  };
  if (query.source === 'all' || query.source === 'tool') {
    try {
      const root = process.env.MCPHUB_AUDIT_LOG_DIR;
      if (!root) unavailableSources.push('tool');
      else {
        const records = await load(join(root, `${query.date}.jsonl`));
        const calls = new Map<string, Record<string, unknown>>();
        for (const record of records) {
          const id = safeString(record.request_id);
          if (['queued', 'dispatched', 'queue_rejected'].includes(safeString(record.event)))
            calls.set(id, { ...calls.get(id), ...record });
          if (record.event === 'completed') calls.set(id, { ...calls.get(id), ...record });
          if (record.event === 'finished') {
            const item = { ...record, ...calls.get(id) };
            const status = safeNumber(item.http_status);
            rows.push({
              id,
              timestamp: safeString(record.ts),
              source: 'tool',
              target: safeString(record.target) || undefined,
              taskId: safeString(record.taskId) || undefined,
              server: safeString(item.server) || safeString(record.group),
              operation: safeString(record.tool),
              outcome: record.status === 'error' || item.status === 'error' ? 'error' : 'success',
              ...(status ? { httpStatus: status } : {}),
              category: safeString(item.category) || undefined,
              durationMs: safeNumber(item.duration_ms),
              waitMs: safeNumber(item.wait_ms),
            });
          }
        }
      }
    } catch {
      unavailableSources.push('tool');
    }
  }
  if (query.source === 'all' || query.source === 'yibu') {
    try {
      const root = process.env.MCP_USAGE_LOG_DIR;
      if (!root) unavailableSources.push('yibu');
      else {
        const directory = join(root, query.date.slice(0, 7));
        let files: string[] = [];
        try {
          files = await readdir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const selected = files.filter((name) =>
          name.endsWith(`_${query.date.replace(/-/g, '')}.jsonl`),
        );
        for (const name of selected.slice(0, 32)) {
          for (const record of await load(join(directory, name))) {
            if (record.event !== 'finished') continue;
            const status = safeNumber(record.status);
            rows.push({
              id: safeString(record.request_id),
              timestamp: safeString(record.ts),
              source: 'yibu',
              server: safeString(record.service),
              operation: 'HTTP',
              outcome: record.error || !status || status >= 400 ? 'error' : 'success',
              ...(status && status >= 100 ? { httpStatus: status } : {}),
              category: record.error
                ? 'network_error'
                : status === 429
                  ? 'rate_limit'
                  : status && status >= 400
                    ? 'upstream_error'
                    : undefined,
              durationMs: safeNumber(record.duration_ms),
            });
          }
        }
        truncated ||= selected.length > 32;
      }
    } catch {
      unavailableSources.push('yibu');
    }
  }
  if (query.source === 'all' || query.source === 'relay') {
    try {
      const file = process.env.MCPHUB_RELAY_LOG_FILE;
      if (!file) unavailableSources.push('relay');
      else {
        const starts = new Map<string, Record<string, unknown>>();
        for (const raw of await load(file)) {
          const id = safeString(raw.request_id);
          if (raw.event === 'http_started') {
            starts.set(id, raw);
            continue;
          }
          const record = { ...starts.get(id), ...raw };
          if (raw.event === 'http_finished') starts.delete(id);
          // Per-attempt records count actual HTTP requests; workflow summaries are omitted.
          if (
            !['http_finished', 'request_rejected'].includes(safeString(record.event)) &&
            !record.account_error_code
          )
            continue;
          const status = safeNumber(record.status);
          rows.push({
            id: safeString(record.request_id),
            timestamp: safeString(record.timestamp),
            source: 'relay',
            server: safeString(record.upstream_group) || safeString(record.host) || 'relay',
            operation: safeString(record.path) || 'HTTP',
            outcome:
              record.category === 'network_error' || record.error_type || !status || status >= 400
                ? 'error'
                : 'success',
            ...(status && status >= 100 ? { httpStatus: status } : {}),
            category:
              safeString(record.category) || (record.error_type ? 'network_error' : undefined),
            durationMs: safeNumber(record.duration_ms),
            waitMs: safeNumber(record.queued_ms),
            attempts: safeNumber(record.attempt),
          });
        }
      }
    } catch {
      unavailableSources.push('relay');
    }
  }
  if (query.source === 'all' || query.source === 'key_pool') {
    try {
      for (const record of await load(join(keyPoolLogDirectory(), `${query.date}.jsonl`))) {
        if (!['finished', 'pool_unavailable'].includes(safeString(record.event))) continue;
        rows.push({
          id: safeString(record.request_id),
          timestamp: safeString(record.ts),
          source: 'key_pool',
          target: safeString(record.target) || undefined,
          server: safeString(record.server),
          operation: safeString(record.path) || 'HTTP',
          outcome: record.outcome === 'error' ? 'error' : 'success',
          httpStatus: safeNumber(record.http_status),
          category: safeString(record.category),
          keyLabel: safeString(record.key_label) || safeString(record.key_id),
          retryAt: safeString(record.retry_at) || undefined,
          durationMs: safeNumber(record.duration_ms),
        });
      }
    } catch {
      unavailableSources.push('key_pool');
    }
  }
  const filtered = rows
    .filter((row) => matchesCallLog(row, query))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return {
    rows: filtered.slice((query.page - 1) * query.limit, query.page * query.limit),
    total: filtered.length,
    truncated,
    unavailableSources,
  };
}
