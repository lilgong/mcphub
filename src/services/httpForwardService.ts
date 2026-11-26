import { ipPoolConnectionOptions, type HttpEgress } from './ipPoolTransportService.js';
import { forwardingResponseHeaders } from '../utils/httpForwardHeaders.js';
import { decodedHttpPreview } from '../utils/httpResponseBody.js';
import { randomUUID } from 'node:crypto';
import { upstreamCredential } from '../utils/upstreamCredential.js';
import { captureToolDiagnostic } from './toolAuditService.js';
import axios from 'axios';
import type { ServerConfig } from '../types/index.js';
import { assertSafeUrl, ssrfConnectionOptions } from '../utils/ssrf.js';

/** Join only a relative path inside the configured upstream prefix. */
export function forwardingUrl(base: string, path: string, query = ''): string {
  const upstream = new URL(base);
  if (
    !['http:', 'https:'].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash
  )
    throw new Error('Invalid upstream URL');
  if (path === '') {
    upstream.search = query;
    return upstream.href;
  }
  // Validate transport syntax without interpreting encoded separators as path structure.
  // An object named "folder/../file" is data when its slashes are encoded.
  const hasControl = (value: string) =>
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (!path.startsWith('/') || path.startsWith('//') || /[\\?#]/.test(path) || hasControl(path))
    throw new Error('Invalid forwarding path');
  const decoded = decodeURIComponent(path);
  if (decoded.startsWith('//') || decoded.includes('\\') || hasControl(decoded))
    throw new Error('Invalid forwarding path');
  if (
    path.split('/').some((part) => {
      const segment = decodeURIComponent(part);
      return segment === '.' || segment === '..';
    })
  )
    throw new Error('Invalid forwarding path');
  const prefix = upstream.pathname.replace(/\/$/, '');
  upstream.pathname = prefix + path;
  if (upstream.pathname !== prefix && !upstream.pathname.startsWith(prefix + '/'))
    throw new Error('Invalid forwarding path');
  upstream.search = query;
  return upstream.href;
}

export interface ForwardResponse {
  status: number;
  isError: boolean;
  body: Buffer;
  headers: Record<string, string>;
  rateLimited?: boolean;
  grpcStatus?: number;
  streamed?: boolean;
}

/** One request, no redirects or automatic retries; benchmarks retain their own retries. */
export async function requestHttpUpstream(
  config: ServerConfig,
  url: string,
  method: string,
  body: Buffer | undefined,
  clientHeaders: Record<string, string>,
  signal: AbortSignal,
  allowInternal: boolean,
  maxBytes = Infinity,
  credentialAliases?: ReturnType<typeof upstreamCredential>[],
  egress?: HttpEgress,
): Promise<ForwardResponse> {
  await assertSafeUrl(url, { allowInternal });
  const headers = { ...clientHeaders };
  // Operator headers win, case-insensitively. Client credentials are never copied.
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    const lower = name.toLowerCase();
    if (
      ['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'cookie'].includes(
        lower,
      )
    )
      continue;
    headers[lower] = value;
  }
  const log = captureToolDiagnostic('');
  const credentials =
    credentialAliases ??
    Object.entries(headers)
      .filter(([name, value]) => value && /authorization|key|token|secret/i.test(name))
      .map(([name, value]) => upstreamCredential(value, name.toLowerCase()));
  const metadata = {
    ...(egress ? { egress_backend: 'ipwo' } : {}),
    upstream_request_id: randomUUID(),
    http_method: method.toUpperCase(),
    upstream_host: new URL(url).hostname,
    upstream_path: new URL(url).pathname.slice(0, 1000),
    upstream_credentials: JSON.stringify(credentials),
    credential_suffix: credentials.map((value) => `${value.role}: …${value.suffix}`).join(', '),
  };
  // Persist admission before the HTTP request; failure must not spend a credential.
  await log('upstream_started', metadata);
  const started = Date.now();
  let result;
  try {
    result = await axios.request<ArrayBuffer>({
      url,
      method,
      data: body,
      headers,
      signal,
      timeout: config.options?.timeout ?? 60000,
      maxRedirects: 0,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      responseType: 'arraybuffer',
      decompress: false,
      transformRequest: [(value) => value],
      transformResponse: [(value) => value],
      validateStatus: () => true,
      ...ssrfConnectionOptions(allowInternal),
      ...ipPoolConnectionOptions(url, egress),
      proxy: false,
    });
    await log('upstream_finished', {
      ...metadata,
      http_status: result.status,
      provider_request_id:
        typeof result.headers['x-github-request-id'] === 'string'
          ? result.headers['x-github-request-id'].slice(0, 512)
          : undefined,
      duration_ms: Date.now() - started,
      status: result.status >= 400 ? 'error' : 'success',
    });
  } catch (error) {
    await log('upstream_finished', {
      ...metadata,
      http_status:
        signal.aborted || (error as { code?: string }).code === 'ECONNABORTED' ? 504 : 502,
      duration_ms: Date.now() - started,
      status: 'error',
    });
    throw error;
  }
  const responseHeaders = Object.fromEntries(
    Object.entries(forwardingResponseHeaders(result.headers)).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(', ') : value,
    ]),
  );
  let rateLimited = result.status === 429;
  if (result.status === 403) {
    try {
      const message = JSON.parse(
        decodedHttpPreview(Buffer.from(result.data), responseHeaders['content-encoding']).toString(
          'utf8',
        ),
      ).message;
      rateLimited =
        typeof message === 'string' &&
        /secondary rate limit|API rate limit exceeded/i.test(message);
    } catch {
      /* Keep ordinary permission failures distinct from rate limiting. */
    }
  }
  return {
    status: result.status,
    isError: result.status >= 400,
    body: Buffer.from(result.data),
    headers: responseHeaders,
    ...(rateLimited ? { rateLimited: true } : {}),
  };
}
