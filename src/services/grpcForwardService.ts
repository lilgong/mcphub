import { connect, type IncomingHttpHeaders } from 'node:http2';
import { randomUUID } from 'node:crypto';
import { assertSafeUrl, createSafeLookup } from '../utils/ssrf.js';
import { captureToolDiagnostic } from './toolAuditService.js';
import type { ForwardResponse } from './httpForwardService.js';
import type { upstreamCredential } from '../utils/upstreamCredential.js';

/** Unary gRPC frames stay opaque; the provider's protobufs and status are unchanged. */
export async function requestGrpcUpstream(
  url: string,
  body: Buffer,
  headers: Record<string, string>,
  signal: AbortSignal,
  credentials: ReturnType<typeof upstreamCredential>[],
  timeoutMs = 0,
): Promise<ForwardResponse> {
  const executionTimeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (executionTimeout) signal = AbortSignal.any([signal, executionTimeout]);
  await assertSafeUrl(url, { allowInternal: false });
  const parsed = new URL(url);
  const log = captureToolDiagnostic('');
  const metadata = {
    upstream_request_id: randomUUID(),
    upstream_credentials: JSON.stringify(credentials),
    credential_suffix: credentials.map((value) => `${value.role}: …${value.suffix}`).join(', '),
  };
  await log('upstream_started', metadata);
  const started = Date.now();
  try {
    const result = await new Promise<ForwardResponse>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Request cancelled'));
        return;
      }
      const session = connect(parsed.origin, { lookup: createSafeLookup() });
      const stream = session.request({
        ...headers,
        ':method': 'POST',
        ':path': parsed.pathname + parsed.search,
        'content-type': 'application/grpc',
        'grpc-accept-encoding': 'identity',
        te: 'trailers',
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let responseHeaders: IncomingHttpHeaders = {};
      let ended = false;
      const finish = (error?: Error) => {
        if (ended) return;
        ended = true;
        signal.removeEventListener('abort', abort);
        stream.destroy();
        session.destroy();
        if (error) reject(error);
      };
      const abort = () =>
        finish(
          executionTimeout?.aborted
            ? Object.assign(new Error('Upstream gRPC execution timed out'), {
                code: 'UPSTREAM_TIMEOUT',
              })
            : new Error('Request cancelled'),
        );
      signal.addEventListener('abort', abort, { once: true });
      session.on('error', finish);
      stream.on('error', finish);
      stream.on('close', () => {
        if (!ended) finish(new Error('Incomplete gRPC response'));
      });
      stream.on('response', (headers) => {
        responseHeaders = headers;
      });
      stream.on('trailers', (trailers) => {
        responseHeaders = { ...responseHeaders, ...trailers };
      });
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) finish(new Error('Response too large'));
        else chunks.push(chunk);
      });
      stream.on('end', () => {
        const status = Number(responseHeaders[':status']) || 502;
        const grpcStatus = String(responseHeaders['grpc-status'] ?? '2');
        const selected: Record<string, string> = {
          'content-type': 'application/grpc',
          'grpc-status': grpcStatus,
        };
        for (const name of [
          'grpc-message',
          'grpc-encoding',
          'grpc-status-details-bin',
          'retry-after',
        ])
          if (typeof responseHeaders[name] === 'string')
            selected[name] = responseHeaders[name] as string;
        const response = {
          status,
          grpcStatus: Number(grpcStatus),
          isError: status >= 400 || grpcStatus !== '0',
          ...(grpcStatus === '8' ? { rateLimited: true } : {}),
          headers: selected,
          body: Buffer.concat(chunks),
        };
        if (!ended) {
          finish();
          resolve(response);
        }
      });
      stream.end(body);
    });
    await log('upstream_finished', {
      ...metadata,
      http_status: result.status,
      grpc_status: Number(result.headers['grpc-status']),
      status: result.isError ? 'error' : 'success',
      duration_ms: Date.now() - started,
    });
    return result;
  } catch (error) {
    await log('upstream_finished', {
      ...metadata,
      http_status: signal.aborted ? 504 : 502,
      status: 'error',
      duration_ms: Date.now() - started,
    });
    throw error;
  }
}
