import { keySuffix } from '../utils/keySuffix.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { KeyPoolConfig, KeyPoolResponse } from '../types/keyPool.js';
import { getServerDao } from '../dao/DaoFactory.js';

const tokens = new Map<string, string>();
export function keyPoolToken(server: string): string {
  let token = tokens.get(server);
  if (!token) {
    token = randomBytes(32).toString('hex');
    tokens.set(server, token);
  }
  return token;
}
export function authenticateKeyPool(server: string, supplied: string): boolean {
  const expected = tokens.get(server);
  return (
    !!expected &&
    Buffer.byteLength(supplied) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  );
}
export function keyPoolLogDirectory(): string {
  return (
    process.env.MCPHUB_KEY_POOL_LOG_DIR ||
    join(
      dirname(process.env.MCPHUB_AUDIT_LOG_DIR || join(process.cwd(), 'data', 'tool-audit')),
      'key-pool',
    )
  );
}
export function writeKeyAttempt(event: string, fields: Record<string, unknown>): void {
  const directory = keyPoolLogDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString();
  const fd = openSync(join(directory, `${ts.slice(0, 10)}.jsonl`), 'a', 0o600);
  try {
    const line = Buffer.from(`${JSON.stringify({ ts, event, ...fields })}\n`);
    if (writeSync(fd, line) !== line.length) throw new Error('Incomplete key audit write');
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
}
type Reason = 'quota_exhausted' | 'authorization' | 'rate_limit';
interface State {
  retryAt: number;
  reason?: Reason;
}
export interface Failure {
  reason?: Reason;
  effectiveStatus: number;
  retryAt?: number;
}
export function classifyKeyResponse(
  provider: KeyPoolConfig['provider'],
  response: KeyPoolResponse,
  now: number,
): Failure {
  let payload: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(response.body);
    if (value && typeof value === 'object' && !Array.isArray(value))
      payload = value as Record<string, unknown>;
  } catch {
    /* Successful documentation can be plain text. */
  }
  const status =
    provider === 'twelvedata' && payload.status === 'error' && typeof payload.code === 'number'
      ? payload.code
      : response.status;
  const message = String(payload.message || payload.error || '').toLowerCase();
  const ambiguous = /rate limit.*or.*quota|rate limited or quota/.test(message);
  // Never interpret quota-related text inside successful documentation as an error.
  if (status < 400) return { effectiveStatus: status };
  const retry = response.headers['retry-after'];
  const seconds = retry === undefined ? NaN : Number(retry);
  const reset = Number(response.headers['ratelimit-reset']);
  const hinted = Math.max(
    Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retry || '') || 0,
    Number.isFinite(reset) ? reset * 1000 : 0,
  );
  let reason: Reason | undefined;
  if (status === 401 || /invalid api key|apikey is invalid|api key.*invalid/.test(message))
    reason = 'authorization';
  else if (
    status === 402 ||
    (!ambiguous &&
      /quota.*(exceeded|reached|exhausted)|credits.*(day|exhausted|remaining)|run out of api credits|daily.*limit|monthly.*limit/.test(
        message,
      ))
  )
    reason = 'quota_exhausted';
  else if (status === 429) reason = 'rate_limit';
  if (!reason) return { effectiveStatus: status };
  const day = new Date(now);
  day.setUTCHours(24, 0, 0, 0);
  const month = new Date(now);
  month.setUTCMonth(month.getUTCMonth() + 1, 1);
  month.setUTCHours(0, 0, 0, 0);
  const fallback =
    reason === 'quota_exhausted' && /month/.test(message)
      ? month.getTime()
      : reason === 'quota_exhausted' && /day|daily/.test(message)
        ? day.getTime()
        : now + 60000;
  return {
    reason,
    effectiveStatus: status,
    retryAt: hinted > now ? Math.min(hinted, now + 366 * 86400000) : fallback,
  };
}
const unavailable = (permanent: boolean): KeyPoolResponse => ({
  status: permanent ? 402 : 429,
  headers: { 'content-type': 'application/json', 'retry-after': '60' },
  body: JSON.stringify({
    error: permanent ? 'key_pool_exhausted' : 'key_pool_temporarily_unavailable',
    message: permanent
      ? 'Error: KEY_POOL_EXHAUSTED: quota exhausted or invalid API key for all configured keys.'
      : 'Error: HTTP 429: all configured API keys are temporarily unavailable; retry later.',
  }),
});
export class KeyPoolService {
  private cursors = new Map<string, number>();
  private states = new Map<string, State>();
  constructor(
    private load: (server: string) => Promise<KeyPoolConfig | undefined>,
    private send: (
      url: URL,
      headers: Record<string, string>,
      signal: AbortSignal,
    ) => Promise<KeyPoolResponse>,
    private audit = writeKeyAttempt,
    private now = Date.now,
  ) {}
  async request(server: string, target: string, signal: AbortSignal): Promise<KeyPoolResponse> {
    const pool = await this.load(server);
    if (!pool?.enabled || !pool.keys.length) throw new Error('Key pool is not enabled');
    const url = new URL(target);
    const host = pool.provider === 'context7' ? 'context7.com' : 'api.twelvedata.com';
    if (
      url.protocol !== 'https:' ||
      url.hostname !== host ||
      (url.port && url.port !== '443') ||
      url.username ||
      url.password ||
      !(pool.provider === 'context7'
        ? url.pathname.startsWith('/api/')
        : /^\/[a-zA-Z0-9_./%:-]+$/.test(url.pathname))
    )
      throw new Error('Unsupported key pool target');
    for (const key of [...url.searchParams.keys()])
      if (/^(apikey|api_key|key|token)$/i.test(key)) url.searchParams.delete(key);
    url.hash = '';
    const attempted = new Set<string>();
    const stateId = (key: KeyPoolConfig['keys'][number]) =>
      `${server}:${pool.provider}:${key.id}:${createHash('sha256').update(key.value).digest('hex')}`;
    while (attempted.size < pool.keys.length) {
      signal.throwIfAborted();
      const cursor = this.cursors.get(server) || 0;
      let selected = -1;
      for (let offset = 0; offset < pool.keys.length; offset++) {
        const index = (cursor + offset) % pool.keys.length;
        const key = pool.keys[index];
        if (!attempted.has(key.id) && (this.states.get(stateId(key))?.retryAt || 0) <= this.now()) {
          selected = index;
          break;
        }
      }
      if (selected < 0) break;
      const key = pool.keys[selected];
      this.cursors.set(server, (selected + 1) % pool.keys.length);
      attempted.add(key.id);
      const upstream = new URL(url);
      const headers: Record<string, string> = {};
      if (pool.provider === 'context7') headers.Authorization = `Bearer ${key.value}`;
      else upstream.searchParams.set('apikey', key.value);
      const started = this.now();
      const metadata = {
        request_id: randomUUID(),
        server,
        key_id: key.id,
        key_label: keySuffix(key.value),
        path: url.pathname,
      };
      // Durable admission is mandatory before the credential reaches an upstream request.
      this.audit('started', metadata);
      let response: KeyPoolResponse;
      try {
        response = await this.send(upstream, headers, signal);
      } catch {
        this.audit('finished', {
          ...metadata,
          category: signal.aborted ? 'cancelled' : 'network_error',
          outcome: 'error',
          duration_ms: this.now() - started,
        });
        throw new Error(
          signal.aborted ? 'Key pool request cancelled' : 'Key pool upstream network failure',
        );
      }
      const failure = classifyKeyResponse(pool.provider, response, this.now());
      this.audit('finished', {
        ...metadata,
        http_status: response.status,
        provider_status: failure.effectiveStatus,
        outcome: failure.effectiveStatus >= 400 ? 'error' : 'success',
        category: failure.reason || (failure.effectiveStatus >= 400 ? 'upstream_error' : 'success'),
        retry_at: failure.retryAt ? new Date(failure.retryAt).toISOString() : undefined,
        duration_ms: this.now() - started,
      });
      if (failure.reason) {
        this.states.set(stateId(key), { reason: failure.reason, retryAt: failure.retryAt! });
        continue;
      }
      // Successful probes return expired keys to service. Non-key errors are returned once.
      if ((this.states.get(stateId(key))?.retryAt || 0) <= started)
        this.states.delete(stateId(key));
      for (const entry of pool.keys)
        response.body = response.body.split(entry.value).join('[REDACTED_KEY]');
      return response;
    }
    const permanent = pool.keys.every((key) =>
      ['quota_exhausted', 'authorization'].includes(this.states.get(stateId(key))?.reason || ''),
    );
    this.audit('pool_unavailable', {
      request_id: randomUUID(),
      server,
      category: permanent ? 'key_pool_exhausted' : 'rate_limit',
      outcome: 'error',
      http_status: permanent ? 402 : 429,
    });
    return unavailable(permanent);
  }
}
async function sendUpstream(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<KeyPoolResponse> {
  const response = await fetch(url, { headers, signal, redirect: 'error' });
  let size = 0;
  const chunks: Buffer[] = [];
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('Upstream response too large');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  const safeHeaders: Record<string, string> = {};
  for (const key of [
    'content-type',
    'retry-after',
    'ratelimit-reset',
    'ratelimit-limit',
    'ratelimit-remaining',
  ]) {
    const value = response.headers.get(key);
    if (value) safeHeaders[key] = value;
  }
  return {
    status: response.status,
    headers: safeHeaders,
    body: Buffer.concat(chunks).toString('utf8'),
  };
}
export const keyPoolService = new KeyPoolService(
  async (server) => (await getServerDao().findById(server))?.keyPool,
  sendUpstream,
);
