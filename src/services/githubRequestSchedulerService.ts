import { decodedHttpPreview } from '../utils/httpResponseBody.js';
import { githubThrottleStore, type GithubThrottleStore } from './githubThrottleStore.js';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ForwardResponse } from './httpForwardService.js';
import { captureToolDiagnostic } from './toolAuditService.js';

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
  streaming?: boolean;
  identify: () => Promise<ForwardResponse>;
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
    const abort = () => reject(signal.reason ?? new Error('GitHub request cancelled'));
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
  constructor(private store?: GithubThrottleStore) {}
  async run(request: GithubRequest): Promise<ForwardResponse> {
    const log = captureToolDiagnostic('');
    const key = createHash('sha256').update(request.credential).digest('hex');
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
        const result = await request.identify();
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
    const selected = await abortable(identity, request.signal);
    if (selected.error) {
      log('github_identity_failed', {
        http_status: selected.error.status,
        category: githubAccountError(selected.error) ? 'account_error' : 'rate_limit',
      });
      return selected.error;
    }
    const account = selected.account!;
    let state = this.accounts.get(account);
    if (!state) {
      state = { tail: Promise.resolve(), cooldownUntil: 0, nextWriteAt: 0, failures: 0 };
      this.accounts.set(account, state);
      const current = state;
      current.ready = (async () => {
        const stored = await this.store?.load(account);
        if (stored) Object.assign(current, stored);
      })();
    }
    await abortable(state.ready ?? Promise.resolve(), request.signal);
    const before = state.tail;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.tail = before.then(() => held);
    const started = Date.now();
    let waited = 0;
    const mutation = githubMutation(request.url, request.method, request.body);
    try {
      log('github_queued', {
        github_account_id: account,
        http_method: request.method,
        upstream_path: new URL(request.url).pathname.slice(0, 1000),
      });
      await abortable(before, request.signal);
      waited += Date.now() - started;
      for (let attempt = 0; attempt < 3; attempt++) {
        request.signal.throwIfAborted();
        if (this.invalidCredentials.has(key)) return this.invalidCredentials.get(key)!;
        if (state.blocked) return state.blocked;
        let until = Math.max(state.cooldownUntil, mutation ? state.nextWriteAt : 0);
        while (until > Date.now()) {
          log('github_waiting', {
            github_account_id: account,
            cooldown_ms: until - Date.now(),
            wait_ms: waited,
            category: state.cooldownUntil > Date.now() ? 'rate_limit' : 'write_interval',
          });
          const waiting = Date.now();
          try {
            await delay(Math.min(until - Date.now(), 2147483647), undefined, {
              signal: request.signal,
            });
          } finally {
            waited += Date.now() - waiting;
          }
          until = Math.max(state.cooldownUntil, mutation ? state.nextWriteAt : 0);
        }
        log('github_dispatched', {
          github_account_id: account,
          wait_ms: waited,
          attempt: attempt + 1,
        });
        let result: ForwardResponse;
        try {
          result = await request.dispatch();
        } finally {
          if (mutation) {
            state.nextWriteAt = Date.now() + 1000;
            await this.store?.save(account, {
              cooldownUntil: state.cooldownUntil,
              nextWriteAt: state.nextWriteAt,
              failures: state.failures,
            });
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
        if (limited || wait || previousFailures)
          await this.store?.save(account, {
            cooldownUntil: state.cooldownUntil,
            nextWriteAt: state.nextWriteAt,
            failures: state.failures,
          });
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
        // A streamed Git pack cannot be replayed. Network failures and ordinary 4xx/5xx are never retried here.
        if (!limited || request.streaming || attempt === 2) return result;
      }
      throw new Error('GitHub retry budget exhausted');
    } finally {
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
