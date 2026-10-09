import { randomUUID } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';

type AuditMetadata = { tool: string; group?: string; username?: string };

/** Optional durable audit, independent of database activity logging availability. */
export async function withToolAudit<T extends { isError?: boolean }>(
  metadata: AuditMetadata,
  call: () => Promise<T>,
): Promise<T> {
  const directory = process.env.MCPHUB_AUDIT_LOG_DIR;
  if (!directory) return call();
  const requestId = randomUUID();
  const started = Date.now();
  const file = join(directory, `${new Date(started).toISOString().slice(0, 10)}.jsonl`);
  const write = (event: 'started' | 'finished', status?: 'success' | 'error'): void => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const record = {
      ts: new Date().toISOString(),
      request_id: requestId,
      tool: metadata.tool.slice(0, 512),
      group: metadata.group?.slice(0, 512),
      username: metadata.username?.slice(0, 512),
      event,
      ...(status ? { status, duration_ms: Date.now() - started } : {}),
    };
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    const fd = openSync(file, 'a', 0o600);
    try {
      if (writeSync(fd, line) !== line.length) throw new Error('Incomplete tool audit write');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    for (const path of [directory, dirname(directory)]) {
      const fd = openSync(path, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    logger.log('[tool-audit]', record);
  };
  // This must complete before any tool invocation can use an upstream credential.
  write('started');
  let result: T;
  try {
    result = await call();
  } catch (error) {
    write('finished', 'error');
    throw error;
  }
  write('finished', result.isError ? 'error' : 'success');
  return result;
}
