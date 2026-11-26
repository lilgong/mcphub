import { open } from 'node:fs/promises';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { callErrorMessage } from '../utils/callErrorMessage.js';

type RecordValue = Record<string, unknown>;
interface Index {
  inode: number;
  size: number;
  mtime: number;
  offset: number;
  records: RecordValue[];
  bytes: number;
}
// This disposable, process-local index never changes the source logs. Retain only
// display/join metadata, not request bodies, headers, arguments or credentials.
const fields = new Set([
  'event',
  'request_id',
  'parent_request_id',
  'ts',
  'timestamp',
  'server',
  'group',
  'tool',
  'target',
  'taskId',
  'catalog',
  'status',
  'outcome',
  'http_status',
  'category',
  'error_message',
  'error_code',
  'error_type',
  'error',
  'duration_ms',
  'wait_ms',
  'queued_ms',
  'credential_suffix',
  'upstream_host',
  'upstream_path',
  'github_account_id',
  'phase',
  'attempt',
  'account_error_code',
  'upstream_group',
  'host',
  'path',
  'cache_status',
  'service',
  'key_label',
  'key_id',
  'retry_at',
]);
const events = new Set([
  'queued',
  'dispatched',
  'queue_rejected',
  'github_queued',
  'github_dispatched',
  'github_waiting',
  'github_observed',
  'github_cancelled',
  'github_identity_failed',
  'upstream_finished',
  'completed',
  'finished',
  'pool_unavailable',
  'http_started',
  'http_finished',
  'http_completed',
  'request_rejected',
  'cache_hit',
  'http_coalesced',
]);
const cache = new Map<string, Index>();
const pending = new Map<string, Promise<unknown>>();
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

/** Complete-file snapshot, incrementally extended through the last complete line. */
export async function readCallLogRecords(
  path: string,
  options: { allowMissing?: boolean } = {},
): Promise<RecordValue[]> {
  const read = async () => {
    let handle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        cache.delete(path);
        if (options.allowMissing !== false) return [];
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      const old = cache.get(path);
      if (old && old.inode === info.ino && old.size === info.size && old.mtime === info.mtimeMs) {
        cache.delete(path);
        cache.set(path, old);
        return old.records.slice();
      }
      const append = old && old.inode === info.ino && info.size > old.size;
      const index: Index = {
        inode: info.ino,
        size: info.size,
        mtime: info.mtimeMs,
        offset: append ? old.offset : 0,
        records: append ? old.records.slice() : [],
        bytes: append ? old.bytes : 0,
      };
      // Read a fixed-size snapshot so appending writers cannot prolong this query.
      let position = index.offset;
      let tail = Buffer.alloc(0);
      const chunk = Buffer.alloc(64 * 1024);
      while (position < info.size) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, info.size - position),
          position,
        );
        if (!bytesRead) throw new Error('Audit log changed while reading');
        position += bytesRead;
        const bytes = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
        let start = 0;
        let newline: number;
        while ((newline = bytes.indexOf(10, start)) >= 0) {
          const line = bytes.subarray(start, newline).toString('utf8');
          index.offset += newline - start + 1;
          start = newline + 1;
          let raw: RecordValue;
          try {
            raw = JSON.parse(line) as RecordValue;
          } catch {
            continue;
          }
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
          if (!events.has(String(raw.event)) && !raw.account_error_code) continue;
          const record: RecordValue = {};
          for (const key of fields) {
            if (raw[key] === undefined) continue;
            record[key] = ['error', 'error_message'].includes(key)
              ? callErrorMessage(raw[key]) || (key === 'error' && raw[key] ? true : undefined)
              : raw[key];
          }
          index.records.push(record);
          index.bytes += Buffer.byteLength(JSON.stringify(record));
        }
        tail = Buffer.from(bytes.subarray(start));
        await yieldTurn();
      }
      cache.delete(path);
      if (index.bytes <= MAX_CACHE_BYTES) cache.set(path, index);
      let bytes = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
      while (cache.size > 16 || bytes > MAX_CACHE_BYTES) {
        const oldest = cache.keys().next().value!;
        bytes -= cache.get(oldest)!.bytes;
        cache.delete(oldest);
      }
      return index.records;
    } finally {
      await handle.close();
    }
  };
  // Concurrent refreshes share serialization, never mutate a published snapshot.
  const result = (pending.get(path)?.catch(() => undefined) || Promise.resolve()).then(read);
  pending.set(path, result);
  try {
    return await result;
  } finally {
    if (pending.get(path) === result) pending.delete(path);
  }
}
