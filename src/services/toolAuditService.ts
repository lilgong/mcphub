import { invocationLabels } from './invocationLabelsService.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { appendDurableAudit } from './durableAuditService.js';

type AuditMetadata = {
  tool: string;
  server?: string;
  group?: string;
  username?: string;
  target?: string;
  taskId?: string;
};

type Diagnostic = Record<string, string | number | boolean | undefined>;
type DiagnosticWriter = (event: string, fields: Diagnostic) => void | Promise<void>;
const diagnostics = new AsyncLocalStorage<DiagnosticWriter>();

/** Classify failures without persisting payloads, arguments, tokens, or raw error text. */
export function describeToolFailure(
  value: unknown,
): { category: string; http_status?: number; error_code?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as {
    isError?: boolean;
    message?: string;
    code?: unknown;
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  let status = item.status ?? item.statusCode ?? item.response?.status;
  const failed =
    value instanceof Error || item.isError || (typeof status === 'number' && status >= 400);
  if (!failed) return undefined;
  let text = value instanceof Error ? value.message : '';
  if (item.isError) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = '';
    }
  }
  const parsed = /(?:http|status(?:\s+code|_code)?)["':=\s]+([45]\d{2})/i.exec(text);
  if (!status && parsed) status = Number(parsed[1]);
  const rateLimited =
    status === 429 ||
    /http\s*429|429\s+too many|status(?:\s+code|_code)?["':=\s]+429|rate limit exceeded|too many requests/i.test(
      text,
    );
  const category = rateLimited
    ? 'rate_limit'
    : /queue.*timed out/i.test(text)
      ? 'queue_timeout'
      : /queue is full/i.test(text)
        ? 'queue_full'
        : /cancel|abort/i.test(text)
          ? 'cancelled'
          : /timeout|timed out/i.test(text)
            ? 'timeout'
            : status === 401 || status === 403
              ? 'authorization'
              : 'upstream_error';
  const allowedCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);
  return {
    category,
    ...(Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599
      ? { http_status: status }
      : {}),
    ...(typeof item.code === 'string' && allowedCodes.has(item.code)
      ? { error_code: item.code }
      : {}),
  };
}

export function captureToolDiagnostic(server: string): DiagnosticWriter {
  const write = diagnostics.getStore();
  return (event, fields) => {
    if (write)
      return write(event, { ...(server ? { server: server.slice(0, 512) } : {}), ...fields });
    else logger.log('[tool-scheduler]', { event, server, ...fields });
  };
}

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
  const writes: Promise<void>[] = [];
  const write = (event: string, fields: Diagnostic = {}): Promise<void> => {
    const record = {
      ts: new Date().toISOString(),
      request_id: requestId,
      ...invocationLabels(),
      ...metadata,
      tool: metadata.tool.slice(0, 512),
      group: metadata.group?.slice(0, 512),
      username: metadata.username?.slice(0, 512),
      event,
      ...fields,
    };
    const pending = appendDurableAudit(file, record).then(() => {
      logger.log('[tool-audit]', record);
    });
    writes.push(pending);
    // Diagnostic producers are synchronous; surface their write failures at completion.
    void pending.catch(() => undefined);
    return pending;
  };
  // This must complete before any tool invocation can use an upstream credential.
  await write('started');
  return diagnostics.run(write, async () => {
    let result: T;
    try {
      result = await call();
    } catch (error) {
      await write('finished', {
        status: 'error',
        duration_ms: Date.now() - started,
        ...describeToolFailure(error),
      });
      await Promise.all(writes);
      throw error;
    }
    await write('finished', {
      status: result.isError ? 'error' : 'success',
      duration_ms: Date.now() - started,
      ...describeToolFailure(result),
    });
    await Promise.all(writes);
    return result;
  });
}
