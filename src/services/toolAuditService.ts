import { invocationLabels } from './invocationLabelsService.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendDurableAudit } from './durableAuditService.js';
import { logger } from '../utils/logger.js';
import { getActivityLoggingService } from './activityLoggingService.js';
import { callErrorMessage } from '../utils/callErrorMessage.js';

type AuditMetadata = {
  tool: string;
  server?: string;
  group?: string;
  username?: string;
  keyId?: string;
  keyName?: string;
  sourceIp?: string;
  target?: string;
  taskId?: string;
  phase?: string;
};

type Diagnostic = Record<string, string | number | boolean | undefined>;
type DiagnosticWriter = (event: string, fields: Diagnostic) => void | Promise<void>;
const diagnostics = new AsyncLocalStorage<DiagnosticWriter>();

/** Classify failures without persisting payloads, arguments, tokens, or raw error text. */
export function describeToolFailure(
  value: unknown,
  auditDetails = false,
): { category: string; http_status?: number; error_code?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as {
    isError?: boolean;
    message?: string;
    code?: unknown;
    status?: number;
    statusCode?: number;
    response?: { status?: number };
    rateLimited?: boolean;
    grpcStatus?: number;
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
  const parsed = (
    auditDetails
      ? /(?:http(?:\s+error)?|status(?:\s+code|_code)?)["':=\s]+([45]\d{2})\b|\berror\s*\(([45]\d{2})\)|\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Forbidden|Payment Required|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i
      : /(?:http|status(?:\s+code|_code)?)["':=\s]+([45]\d{2})/i
  ).exec(text);
  if (!status && parsed) status = Number(parsed[1] || parsed[2] || parsed[3]);
  const rateLimited =
    item.rateLimited === true ||
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
      : Number.isInteger(item.grpcStatus) &&
          Number(item.grpcStatus) > 0 &&
          Number(item.grpcStatus) <= 16
        ? { error_code: `GRPC_${item.grpcStatus}` }
        : {}),
  };
}

/** Audit-only interpretation: never mutate results or change scheduler/retry decisions. */
export function describeToolAuditFailure(
  value: unknown,
  tool: string,
): ReturnType<typeof describeToolFailure> {
  const protocolFailure = describeToolFailure(value, true);
  if (protocolFailure) return protocolFailure;
  if (
    !/(?:^|_)(?:search_pubmed_key_words|search_pubmed_advanced|get_pubmed_article_metadata|download_pubmed_pdf)$/.test(
      tool,
    )
  )
    return undefined;

  const readError = (item: unknown, depth = 0): string | undefined => {
    if (depth > 4 || item === null || typeof item !== 'object') return undefined;
    if (Array.isArray(item)) {
      for (const entry of item.slice(0, 16)) {
        const error = readError(entry, depth + 1);
        if (error) return error;
      }
      return undefined;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) return record.error.slice(0, 2048);
    if (record.type === 'text' && typeof record.text === 'string' && record.text.length <= 65536) {
      const text = record.text.trim();
      if (
        /^An error occurred while (?:searching|performing advanced search|fetching metadata|attempting to download the PDF):/.test(
          text,
        )
      )
        return text.slice(0, 2048);
      try {
        return readError(JSON.parse(text), depth + 1);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Record<string, unknown>;
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const error = readError(result.content) ?? readError(structured) ?? readError(structured?.result);
  return error ? describeToolFailure(new Error(error)) : undefined;
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
  persistActivity = false,
): Promise<T> {
  // MCP calls already persist their own activity. Direct HTTP/task entry points opt in.
  const invoke = async (): Promise<T> => {
    if (!persistActivity) return call();
    const started = Date.now();
    let failed = true;
    try {
      const result = await call();
      failed = !!describeToolAuditFailure(result, metadata.tool);
      return result;
    } finally {
      await getActivityLoggingService().logToolCall({
        server: metadata.server || 'unknown',
        tool: metadata.tool,
        username: metadata.username,
        keyId: metadata.keyId,
        keyName: metadata.keyName,
        sourceIp: metadata.sourceIp,
        group: metadata.group,
        duration: Date.now() - started,
        status: failed ? 'error' : 'success',
        // Callback and HTTP responses can echo credentials; retain metadata only.
        hasCredentialTemplate: true,
      });
    }
  };
  const directory = process.env.MCPHUB_AUDIT_LOG_DIR;
  if (!directory) return invoke();
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
    // Synchronous diagnostic producers are checked again before completion.
    void pending.catch(() => undefined);
    return pending;
  };
  // This must complete before any tool invocation can use an upstream credential.
  await write('started');
  return diagnostics.run(write, async () => {
    let result: T;
    try {
      result = await invoke();
    } catch (error) {
      await write('finished', {
        status: 'error',
        duration_ms: Date.now() - started,
        ...describeToolFailure(error, true),
        error_message: callErrorMessage(error),
      });
      await Promise.all(writes);
      throw error;
    }
    const failure = describeToolAuditFailure(result, metadata.tool);
    await write('finished', {
      status: failure ? 'error' : 'success',
      duration_ms: Date.now() - started,
      ...failure,
      ...(failure ? { error_message: callErrorMessage(result) } : {}),
    });
    await Promise.all(writes);
    return result;
  });
}
