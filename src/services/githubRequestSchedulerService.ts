import { decodedHttpPreview } from '../utils/httpResponseBody.js';
import { githubThrottleStore, type GithubThrottleStore } from './githubThrottleStore.js';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ForwardResponse } from './httpForwardService.js';
import { captureToolDiagnostic } from './toolAuditService.js';

const ADMISSION_WAIT_MS = 600_000;
const WRITE_WINDOW_MS = 3_600_000;
interface WriteLimits {
  intervalMs: number;
  maxPerHour: number;
}
class GithubAdmissionTimeout extends Error {}

export const GITHUB_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'raw.githubusercontent.com',
  'uploads.github.com',
]);
export function githubMutation(url: string, method: string, body?: Buffer): boolean {
  const upstream = new URL(url);
  if (upstream.hostname === 'github.com')
    return method === 'POST' && upstream.pathname.endsWith('/git-receive-pack');
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return false;
  if (upstream.hostname === 'api.github.com' && upstream.pathname === '/graphql') {
    try {
      const query = JSON.parse(body?.toString('utf8') || '{}').query;
      return typeof query !== 'string' || /\bmutation\b/.test(query.replace(/#[^\n]*/g, ''));
    } catch {
      return true;
    }
  }
  return true;
}
interface State {
  tail: Promise<void>;
  ready?: Promise<void>;
  cooldownUntil: number;
  nextWriteAt: number;
  failures: number;
  writeTimes: number[];
  blocked?: ForwardResponse;
}
interface Identity {
  account?: string;
  error?: ForwardResponse;
}
export interface GithubRequest {
  credential: string;
  url: string;
  method: string;
  body?: Buffer;
  signal: AbortSignal;
  queuedAt?: number;
  identify: (signal: AbortSignal) => Promise<ForwardResponse>;
  dispatch: () => Promise<ForwardResponse>;
}
export function githubAccountError(result: ForwardResponse): boolean {
  if (result.status === 401) return true;
  if (result.status !== 403) return false;
  try {
    return /account (?:was|is|has been) suspended/i.test(
      JSON.parse(decodedHttpPreview(result.body, result.headers['content-encoding']).toString())
        .message || '',
    );
  } catch {
    return false;
  }
}
export function githubRateDelay(result: ForwardResponse, failures: number, now: number): number {
  const headers = result.headers;
  const reset = Number(headers['x-ratelimit-reset']) * 1000;
  const raw = headers['retry-after'];
  const after =
    raw === undefined
      ? 0
      : Number.isFinite(Number(raw))
        ? Number(raw) * 1000
        : Date.parse(raw) - now;
  const limited =
    result.rateLimited === true ||
    result.status === 429 ||
    (result.status === 403 && headers['x-ratelimit-remaining'] === '0');
  if (limited) {
    const afterDelay = Number.isFinite(after) && after > 0 ? after : 0;
    const resetDelay =
      headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset) && reset > now
        ? reset - now
        : 0;
    if (afterDelay || resetDelay) return Math.max(afterDelay, resetDelay);
    return 60000 * 2 ** Math.min(Math.max(0, failures - 1), 10);
  }
  return headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset) && reset > now
    ? reset - now
    : 0;
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('GitHub request cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
/** One FIFO per actual GitHub user, shared by REST, GraphQL and Git across all spaces/runs. */
export class GithubRequestScheduler {
  private identities = new Map<string, Promise<Identity>>();
  private accounts = new Map<string, State>();
  private invalidCredentials = new Map<string, ForwardResponse>();
  private identityCooldowns = new Map<string, number>();
  constructor(
    private store?: GithubThrottleStore,
    private writeLimits: WriteLimits = {
      intervalMs: Number(process.env.MCPHUB_GITHUB_WRITE_INTERVAL_MS || 5000),
      maxPerHour: Number(process.env.MCPHUB_GITHUB_WRITES_PER_HOUR || 300),
    },
  ) {
    if (
      !Number.isSafeInteger(writeLimits.intervalMs) ||
      writeLimits.intervalMs < 1000 ||
      writeLimits.intervalMs > ADMISSION_WAIT_MS ||
      !Number.isSafeInteger(writeLimits.maxPerHour) ||
      writeLimits.maxPerHour < 1 ||
      writeLimits.maxPerHour > 500
    )
      throw new Error('Invalid GitHub write limits');
  }

  private writeReadyAt(state: State): number {
    state.writeTimes = state.writeTimes.filter((time) => time > Date.now() - WRITE_WINDOW_MS);
    const boundary = state.writeTimes.length - this.writeLimits.maxPerHour;
    return Math.max(
      state.nextWriteAt,
      boundary >= 0 ? state.writeTimes[boundary] + WRITE_WINDOW_MS : 0,
    );
  }

  private save(account: string, state: State): Promise<void> | undefined {
    return this.store?.save(account, {
      cooldownUntil: state.cooldownUntil,
      nextWriteAt: state.nextWriteAt,
      failures: state.failures,
      writeTimes: state.writeTimes,
    });
  }
  async run(request: GithubRequest): Promise<ForwardResponse> {
    const started = request.queuedAt ?? Date.now();
    const log = captureToolDiagnostic('');
    const key = createHash('sha256').update(request.credential).digest('hex');
    let account: string | undefined;
    let state: State | undefined;
    let release = () => {};
    let waited = 0;
    const admission = new AbortController();
    const signal = AbortSignal.any([request.signal, admission.signal]);
    const admissionTimer = setTimeout(
      () => admission.abort(new GithubAdmissionTimeout()),
      Math.max(0, started + ADMISSION_WAIT_MS - Date.now()),
    );
    try {
      request.signal.throwIfAborted();
      if (Date.now() >= started + ADMISSION_WAIT_MS) throw new GithubAdmissionTimeout();
      if (this.invalidCredentials.has(key)) return this.invalidCredentials.get(key)!;
      if ((this.identityCooldowns.get(key) ?? 0) <= Date.now() && this.identityCooldowns.has(key)) {
        this.identities.delete(key);
        this.identityCooldowns.delete(key);
      }
      let identity = this.identities.get(key);
      if (!identity) {
        identity = (async () => {
          const stored = await this.store?.identity(key);
          if (stored) return { account: stored };
          signal.throwIfAborted();
          const result = await request.identify(signal);
          if (result.status !== 200) return { error: result };
          const user = JSON.parse(
            decodedHttpPreview(result.body, result.headers['content-encoding']).toString(),
          );
          if (!Number.isSafeInteger(user.id) || user.id <= 0)
            throw new Error('Invalid GitHub identity response');
          const account = String(user.id);
          await this.store?.saveIdentity(key, account);
          return { account };
        })();
        this.identities.set(key, identity);
        void identity.then(
          (value) => {
            if (value.error && !githubAccountError(value.error)) {
              const wait = githubRateDelay(value.error, 1, Date.now());
              if (wait) this.identityCooldowns.set(key, Date.now() + wait);
              else this.identities.delete(key);
            }
          },
          () => this.identities.delete(key),
        );
      }
      const selected = await abortable(identity, signal);
      if (selected.error) {
        log('github_identity_failed', {
          http_status: selected.error.status,
          category: githubAccountError(selected.error) ? 'account_error' : 'rate_limit',
        });
        return selected.error;
      }
      account = selected.account!;
      state = this.accounts.get(account);
      if (!state) {
        state = {
          tail: Promise.resolve(),
          cooldownUntil: 0,
          nextWriteAt: 0,
          failures: 0,
          writeTimes: [],
        };
        this.accounts.set(account, state);
        const current = state;
        current.ready = (async () => {
          try {
            const stored = await this.store?.load(account!);
            if (stored) Object.assign(current, { ...stored, writeTimes: stored.writeTimes ?? [] });
          } catch (error) {
            if (this.accounts.get(account!) === current) this.accounts.delete(account!);
            throw error;
          }
        })();
      }
      await abortable(state.ready ?? Promise.resolve(), signal);
      const mutation = githubMutation(request.url, request.method, request.body);
      const readyAt = Math.max(state.cooldownUntil, mutation ? this.writeReadyAt(state) : 0);
      if (readyAt > started + ADMISSION_WAIT_MS) throw new GithubAdmissionTimeout();
      const before = state.tail;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      state.tail = before.then(() => held);
      log('github_queued', {
        github_account_id: account,
        http_method: request.method,
        upstream_path: new URL(request.url).pathname.slice(0, 1000),
      });
      if (Date.now() >= started + ADMISSION_WAIT_MS) throw new GithubAdmissionTimeout();
      await abortable(before, signal);
      waited += Date.now() - started;
      signal.throwIfAborted();
      if (this.invalidCredentials.has(key)) return this.invalidCredentials.get(key)!;
      if (state.blocked) return state.blocked;
      let until = Math.max(state.cooldownUntil, mutation ? this.writeReadyAt(state) : 0);
      while (until > Date.now()) {
        if (until > started + ADMISSION_WAIT_MS) throw new GithubAdmissionTimeout();
        log('github_waiting', {
          github_account_id: account,
          cooldown_ms: until - Date.now(),
          wait_ms: waited,
          category: state.cooldownUntil >= until ? 'rate_limit' : 'write_budget',
          write_attempts: mutation ? state.writeTimes.length : undefined,
          write_limit: mutation ? this.writeLimits.maxPerHour : undefined,
        });
        const waiting = Date.now();
        try {
          await delay(Math.min(until - Date.now(), 2147483647), undefined, {
            signal,
          });
        } finally {
          waited += Date.now() - waiting;
        }
        until = Math.max(state.cooldownUntil, mutation ? this.writeReadyAt(state) : 0);
      }
      signal.throwIfAborted();
      clearTimeout(admissionTimer);
      if (mutation) state.writeTimes.push(Date.now());
      log('github_dispatched', {
        github_account_id: account,
        wait_ms: waited,
        attempt: 1,
      });
      let result: ForwardResponse;
      try {
        result = await request.dispatch();
      } finally {
        if (mutation) {
          state.nextWriteAt = Date.now() + this.writeLimits.intervalMs;
          await this.save(account, state);
        }
      }
      const limited =
        result.rateLimited === true ||
        result.status === 429 ||
        (result.status === 403 && result.headers['x-ratelimit-remaining'] === '0');
      const previousFailures = state.failures;
      state.failures = limited ? state.failures + 1 : 0;
      const wait = githubRateDelay(result, state.failures, Date.now());
      state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + wait);
      if (result.status === 401) this.invalidCredentials.set(key, result);
      else if (githubAccountError(result)) state.blocked = result;
      if (limited || wait || previousFailures) await this.save(account, state);
      log('github_observed', {
        github_account_id: account,
        http_status: result.status,
        remaining: result.headers['x-ratelimit-remaining'],
        quota_resource: result.headers['x-ratelimit-resource'],
        reset_at: result.headers['x-ratelimit-reset'],
        retry_after: result.headers['retry-after'],
        cooldown_ms: wait,
        category: state.blocked ? 'account_error' : limited ? 'rate_limit' : undefined,
      });
      return result;
    } catch (error) {
      request.signal.throwIfAborted();
      if (!(error instanceof GithubAdmissionTimeout) && !admission.signal.aborted) throw error;
      const writeReady =
        state && githubMutation(request.url, request.method, request.body)
          ? this.writeReadyAt(state)
          : 0;
      const ready = Math.max(state?.cooldownUntil ?? 0, writeReady);
      const retryAfter = Math.max(1, Math.ceil((ready - Date.now()) / 1000));
      log('github_queue_expired', {
        github_account_id: account,
        wait_ms: Date.now() - started,
        cooldown_ms: Math.max(0, (state?.cooldownUntil ?? 0) - Date.now()),
        category: 'queue_timeout',
        wait_reason:
          ready <= Date.now()
            ? 'admission'
            : (state?.cooldownUntil ?? 0) >= writeReady
              ? 'rate_limit'
              : 'write_budget',
      });
      return {
        status: 429,
        isError: true,
        rateLimited: true,
        headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
        body: Buffer.from(
          JSON.stringify({
            message:
              'MCPHub GitHub admission wait budget exceeded; retry after the indicated delay.',
          }),
        ),
      };
    } finally {
      clearTimeout(admissionTimer);
      try {
        if (request.signal.aborted)
          log('github_cancelled', {
            github_account_id: account,
            wait_ms: waited,
            category: 'cancelled',
          });
      } finally {
        release();
      }
    }
  }
}
export const githubRequestScheduler = new GithubRequestScheduler(githubThrottleStore);
