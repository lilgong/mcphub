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
  // Decode repeatedly to reject encoded traversal, separators and scheme injection.
  let decoded = path;
  for (let i = 0; i < 4; i++) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (
    !decoded.startsWith('/') ||
    decoded.startsWith('//') ||
    /[\\?#%]/.test(decoded) ||
    [...decoded].some((char) => char.charCodeAt(0) <= 32) ||
    decoded.split('/').some((part) => part === '..' || part === '.')
  )
    throw new Error('Invalid forwarding path');
  const prefix = upstream.pathname.replace(/\/$/, '');
  upstream.pathname = prefix + path;
  upstream.search = query;
  return upstream.href;
}

export interface ForwardResponse {
  status: number;
  isError: boolean;
  body: Buffer;
  headers: Record<string, string>;
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
  const result = await axios.request<ArrayBuffer>({
    url,
    method,
    data: body,
    headers,
    signal,
    timeout: config.options?.timeout ?? 60000,
    maxRedirects: 0,
    maxContentLength: 8 * 1024 * 1024,
    maxBodyLength: 1024 * 1024,
    responseType: 'arraybuffer',
    transformRequest: [(value) => value],
    transformResponse: [(value) => value],
    validateStatus: () => true,
    ...ssrfConnectionOptions(allowInternal),
    proxy: false,
  });
  const responseHeaders: Record<string, string> = {};
  for (const name of [
    'content-type',
    'retry-after',
    'etag',
    'last-modified',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
  ]) {
    const value = result.headers[name];
    if (typeof value === 'string' || typeof value === 'number')
      responseHeaders[name] = String(value);
  }
  return {
    status: result.status,
    isError: result.status >= 400,
    body: Buffer.from(result.data),
    headers: responseHeaders,
  };
}
