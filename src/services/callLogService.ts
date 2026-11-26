import { readCallLogRecords } from './callLogIndexService.js';
import { usageLogDirectories } from './usageLogDirectories.js';
import { splitServerKey } from '../utils/catalog.js';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { keyPoolLogDirectory } from './keyPoolService.js';
import { callErrorMessage } from '../utils/callErrorMessage.js';

export interface CallLog {
  id: string;
  timestamp: string;
  source: 'tool' | 'yibu' | 'relay' | 'key_pool';
  catalog?: string;
  target?: string;
  taskId?: string;
  keyLabel?: string;
  retryAt?: string;
  server: string;
  operation: string;
  outcome: 'success' | 'error';
  httpStatus?: number;
  category?: string;
  errorMessage?: string;
  errorCode?: string;
  cacheStatus?: string;
  durationMs?: number;
  waitMs?: number;
  attempts?: number;
  upstream?: string;
  githubAccountId?: string;
  phase?: string;
}
export interface CallLogQuery {
  catalog?: string;
  date: string;
  start?: string;
  end?: string;
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
  options: { allowMissing?: boolean } = {},
): Promise<{ records: Record<string, unknown>[]; truncated: boolean }> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.allowMissing !== false)
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
  if (query.catalog !== undefined && query.catalog !== row.catalog) return false;
  if (query.start && query.end) {
    const timestamp = Date.parse(row.timestamp);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < Date.parse(query.start) ||
      timestamp > Date.parse(query.end)
    )
      return false;
  } else if (!row.timestamp.startsWith(query.date)) return false;
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
  const first = query.start || `${query.date}T00:00:00.000Z`;
  const last = query.end || `${query.date}T23:59:59.999Z`;
  const days: string[] = [];
  for (
    let time = Date.parse(first.slice(0, 10));
    time <= Date.parse(last.slice(0, 10));
    time += 86400000
  )
    days.push(new Date(time).toISOString().slice(0, 10));
  // Include the preceding file for calls completing after a UTC day boundary.
  const auditDays = [new Date(Date.parse(days[0]) - 86400000).toISOString().slice(0, 10), ...days];
  const rows: CallLog[] = [];
  const truncated = false;
  const unavailableSources: string[] = [];
  const load = async (path: string, options?: { allowMissing?: boolean }) => {
    return readCallLogRecords(path, options);
  };
  if (query.source === 'all' || query.source === 'tool') {
    try {
      const root = process.env.MCPHUB_AUDIT_LOG_DIR;
      if (!root) unavailableSources.push('tool');
      else {
        // A call's lifecycle stays in its start-day file; filter by completion
        // timestamp after also reading the prior UTC day, as statistics do.
        const records = (
          await Promise.all(auditDays.map((day) => load(join(root, `${day}.jsonl`))))
        ).flat();
        const calls = new Map<string, Record<string, unknown>>();
        for (const record of records) {
          const id = safeString(record.request_id);
          if (
            [
              'queued',
              'dispatched',
              'queue_rejected',
              'github_queued',
              'github_dispatched',
              'github_waiting',
              'github_observed',
              'github_cancelled',
              'github_identity_failed',
            ].includes(safeString(record.event))
          )
            calls.set(id, { ...calls.get(id), ...record });
          if (record.event === 'upstream_finished') calls.set(id, { ...calls.get(id), ...record });
          if (record.event === 'completed') calls.set(id, { ...calls.get(id), ...record });
          if (record.event === 'finished') {
            // Diagnostics fill missing fields; the final outcome and total
            // duration must never be replaced by an individual HTTP attempt.
            const item = { ...calls.get(id), ...record };
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
              errorMessage: callErrorMessage(item.error_message),
              errorCode: safeString(item.error_code) || undefined,
              durationMs: safeNumber(item.duration_ms),
              waitMs: safeNumber(item.wait_ms),
              keyLabel: safeString(item.credential_suffix) || undefined,
              upstream:
                safeString(item.upstream_host) + safeString(item.upstream_path) || undefined,
              githubAccountId: safeString(item.github_account_id) || undefined,
              phase: safeString(record.phase) || undefined,
              attempts: safeNumber(item.attempt),
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
        for (const identity of await usageLogDirectories(root)) {
          for (const day of days) {
            const directory = join(identity.directory, day.slice(0, 7));
            let files: string[] = [];
            try {
              files = await readdir(directory);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            const selected = files.filter((name) =>
              name.endsWith(`_${day.replace(/-/g, '')}.jsonl`),
            );
            for (const name of selected.sort()) {
              for (const record of await load(join(directory, name))) {
                if (record.event !== 'finished') continue;
                const status = safeNumber(record.status);
                rows.push({
                  id: safeString(record.request_id),
                  timestamp: safeString(record.ts),
                  source: 'yibu',
                  server: identity.server || safeString(record.service),
                  catalog: identity.catalog,
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
                  errorMessage: callErrorMessage(record.error),
                });
              }
            }
          }
        }
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
        const records = await load(file, { allowMissing: false });
        // Attempt IDs differ from workflow IDs. Suppress workflow timeout
        // summaries only when an actual HTTP attempt represents that flow.
        const finishedFlows = new Set(
          records
            .filter((record) => record.event === 'http_finished')
            .map((record) => safeString(record.parent_request_id) || safeString(record.request_id))
            .filter(Boolean),
        );
        for (const raw of records) {
          const id = safeString(raw.request_id);
          if (raw.event === 'http_completed' && finishedFlows.has(id)) continue;
          if (raw.event === 'http_started') {
            starts.set(id, raw);
            continue;
          }
          const record = { ...starts.get(id), ...raw };
          if (raw.event === 'http_finished') starts.delete(id);
          // Per-attempt records count actual HTTP requests; workflow summaries are omitted.
          if (
            !['http_finished', 'request_rejected', 'cache_hit', 'http_coalesced'].includes(
              safeString(record.event),
            ) &&
            !(
              raw.event === 'http_completed' &&
              ['queue_timeout', 'upstream_timeout', 'client_cancelled'].includes(
                safeString(raw.category),
              )
            ) &&
            !record.account_error_code
          )
            continue;
          const status = safeNumber(record.status);
          rows.push({
            id: safeString(record.request_id),
            timestamp: safeString(record.timestamp),
            source: 'relay',
            // Unattributed Relay attempts must not masquerade as public MCPs.
            catalog:
              typeof record.catalog === 'string' &&
              /^(?:[a-z][a-z0-9_-]{0,47})?$/.test(record.catalog)
                ? record.catalog
                : '_unassigned',
            server: safeString(record.upstream_group) || safeString(record.host) || 'relay',
            operation: safeString(record.path) || 'HTTP',
            outcome:
              record.category === 'network_error' || record.error_type || !status || status >= 400
                ? 'error'
                : 'success',
            ...(status && status >= 100 ? { httpStatus: status } : {}),
            category:
              safeString(record.category) || (record.error_type ? 'network_error' : undefined),
            errorMessage: callErrorMessage(
              record.error_message ?? record.error ?? record.error_type,
            ),
            durationMs: safeNumber(record.duration_ms),
            waitMs: safeNumber(record.queued_ms),
            attempts: safeNumber(record.attempt),
            cacheStatus: safeString(record.cache_status) || undefined,
          });
        }
      }
    } catch {
      unavailableSources.push('relay');
    }
  }
  if (query.source === 'all' || query.source === 'key_pool') {
    try {
      for (const record of (
        await Promise.all(auditDays.map((day) => load(join(keyPoolLogDirectory(), `${day}.jsonl`))))
      ).flat()) {
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
          errorMessage: callErrorMessage(record.error_message ?? record.error),
          errorCode: safeString(record.error_code) || undefined,
          keyLabel: safeString(record.key_label) || safeString(record.key_id),
          retryAt: safeString(record.retry_at) || undefined,
          durationMs: safeNumber(record.duration_ms),
        });
      }
    } catch {
      unavailableSources.push('key_pool');
    }
  }
  for (const row of rows) row.catalog ??= splitServerKey(row.server).catalog;
  const seen = new Set<string>();
  const filtered = rows
    .filter((row) => {
      if (!matchesCallLog(row, query)) return false;
      if (!row.id) return true;
      const key = JSON.stringify([
        row.source,
        row.catalog,
        row.server,
        row.id,
        row.source === 'relay' ? row.attempts : undefined,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
  return {
    rows: filtered.slice((query.page - 1) * query.limit, query.page * query.limit),
    total: filtered.length,
    truncated,
    unavailableSources,
  };
}
