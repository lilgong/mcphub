import { performance } from 'node:perf_hooks';
import type { ServiceRateLimit } from '../types/serviceControls.js';
import { getServerDao } from '../dao/DaoFactory.js';
import { captureToolDiagnostic, describeToolFailure } from './toolAuditService.js';

type Policy = ServiceRateLimit;
interface Waiter {
  server: string;
  queuedAt: number;
  call: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  log: ReturnType<typeof captureToolDiagnostic>;
}
interface Bucket {
  active: number;
  queue: Waiter[];
  lastStarted: number;
  cooldownUntil: number;
  rateLimits: number;
  calls: number;
  errors: number;
  starts: number[];
  timer?: ReturnType<typeof setTimeout>;
  pumping?: boolean;
  repump?: boolean;
}

export function isUpstreamRateLimit(value: unknown): boolean {
  return describeToolFailure(value)?.category === 'rate_limit';
}

// Only structured Retry-After data is trusted. Error text and payloads are not logged.
export function retryAfterMs(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const item = value as {
    retryAfter?: unknown;
    headers?: Record<string, unknown>;
    response?: { headers?: Record<string, unknown> };
  };
  const raw =
    item.headers?.['retry-after'] ??
    item.headers?.['Retry-After'] ??
    item.response?.headers?.['retry-after'] ??
    item.retryAfter;
  if (raw === undefined || raw === null || raw === '') return 0;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(raw)) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 2147483647)) : 0;
}

/** Shared FIFO per registered MCP, across all callers in a single Hub process. */
export class ToolCallScheduler {
  private buckets = new Map<string, Bucket>();
  constructor(
    private policy: (server: string) => Policy | undefined | Promise<Policy | undefined>,
  ) {}

  async run<T>(
    server: string,
    call: () => Promise<T>,
    _principal = 'system',
    signal?: AbortSignal,
  ): Promise<T> {
    const log = captureToolDiagnostic(server);
    const policy = await this.policy(server);
    if (signal?.aborted) {
      log('cancelled', { category: 'cancelled' });
      throw new Error('Tool call cancelled');
    }
    let bucket = this.buckets.get(server);
    if (!bucket) {
      bucket = {
        active: 0,
        queue: [],
        lastStarted: -Infinity,
        cooldownUntil: 0,
        rateLimits: 0,
        calls: 0,
        errors: 0,
        starts: [],
      };
      this.buckets.set(server, bucket);
    }
    if (
      policy?.enabled &&
      policy.maxQueued &&
      bucket.queue.length >= policy.maxQueued + (bucket.active === 0 ? 1 : 0)
    ) {
      log('queue_rejected', { category: 'queue_full', queued: bucket.queue.length });
      throw new Error(`Tool queue is full for '${server}'`);
    }
    const state = bucket;
    return new Promise<T>((resolve, reject) => {
      const remove = (category: string, message: string) => {
        const index = state.queue.indexOf(waiter);
        if (index < 0) return;
        state.queue.splice(index, 1);
        waiter.cleanup();
        state.errors++;
        try {
          log('queue_rejected', {
            category,
            wait_ms: Math.ceil(performance.now() - waiter.queuedAt),
          });
        } catch {
          /* The mandatory admission record already exists; never leave a promise pending. */
        }
        reject(new Error(message));
        this.pump(state);
      };
      const abort = () => remove('cancelled', 'Tool call cancelled while queued');
      // This is a waiting deadline, not an invented upstream quota. Callers should also pass cancellation.
      const timeout = setTimeout(
        () => remove('queue_timeout', `Tool queue wait timed out for '${server}'`),
        policy?.queueTimeoutMs ?? 60000,
      );
      const waiter: Waiter = {
        server,
        queuedAt: performance.now(),
        call,
        log,
        resolve: (result) => resolve(result as T),
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        log('queued', {
          active: state.active,
          queued: state.queue.length + 1,
          limited: policy?.enabled === true,
        });
      } catch (error) {
        waiter.cleanup();
        reject(error);
        return;
      }
      state.queue.push(waiter);
      this.pump(state);
    });
  }

  refresh(): void {
    for (const bucket of this.buckets.values()) this.pump(bucket);
  }

  private pump(bucket: Bucket): void {
    if (bucket.pumping) {
      bucket.repump = true;
      return;
    }
    bucket.pumping = true;
    void this.pumpAsync(bucket)
      .catch(() => {
        for (const waiter of bucket.queue.splice(0)) {
          waiter.cleanup();
          try {
            waiter.log('queue_rejected', { category: 'configuration_unavailable' });
          } catch {
            /* Reject regardless of log availability. */
          }
          waiter.reject(new Error('MCP rate configuration unavailable'));
        }
      })
      .finally(() => {
        bucket.pumping = false;
        if (bucket.repump) {
          bucket.repump = false;
          this.pump(bucket);
        }
      });
  }

  private async pumpAsync(bucket: Bucket): Promise<void> {
    clearTimeout(bucket.timer);
    bucket.timer = undefined;
    while (bucket.queue.length) {
      const waiter = bucket.queue[0];
      const policy = await this.policy(waiter.server);
      // Cancellation or waiting deadlines can remove the head while configuration is loading.
      if (bucket.queue[0] !== waiter) continue;
      const limited = policy?.enabled === true;
      if (limited && policy.concurrency && bucket.active >= policy.concurrency) return;
      const now = performance.now();
      const window = limited && policy.windowMs && policy.maxCalls ? policy.windowMs : 0;
      bucket.starts = window ? bucket.starts.filter((start) => now - start < window) : [];
      const windowReady =
        window && policy?.maxCalls && bucket.starts.length >= policy.maxCalls
          ? bucket.starts[bucket.starts.length - policy.maxCalls] + window
          : now;
      const ready = limited
        ? Math.max(
            bucket.lastStarted + (policy.minIntervalMs ?? 0),
            bucket.cooldownUntil,
            windowReady,
          )
        : now;
      if (ready > now) {
        bucket.timer = setTimeout(() => this.pump(bucket), Math.ceil(ready - now));
        return;
      }
      bucket.queue.shift();
      waiter.cleanup();
      try {
        waiter.log('dispatched', {
          wait_ms: Math.ceil(now - waiter.queuedAt),
          active: bucket.active + 1,
        });
      } catch (error) {
        waiter.reject(error as Error);
        bucket.errors++;
        continue;
      }
      bucket.active++;
      bucket.lastStarted = now;
      if (window) bucket.starts.push(now);
      bucket.calls++;
      void (async () => {
        try {
          const result = await waiter.call();
          this.observe(bucket, policy, result, waiter, now);
          waiter.resolve(result);
        } catch (error) {
          try {
            this.observe(bucket, policy, error, waiter, now);
          } catch {
            /* Preserve the original failure. */
          }
          waiter.reject(error as Error);
        } finally {
          bucket.active--;
          this.pump(bucket);
        }
      })();
    }
  }

  private observe(
    bucket: Bucket,
    policy: Policy | undefined,
    result: unknown,
    waiter: Waiter,
    started: number,
  ): void {
    const failure = describeToolFailure(result);
    if (failure) bucket.errors++;
    let delay = 0;
    if (policy?.enabled && isUpstreamRateLimit(result)) {
      bucket.rateLimits++;
      const backoff = (policy.rateLimitBackoffMs ?? 0) * 2 ** Math.min(bucket.rateLimits - 1, 20);
      delay = Math.max(retryAfterMs(result), Math.min(backoff, policy.maxBackoffMs ?? backoff));
      bucket.cooldownUntil = Math.max(bucket.cooldownUntil, performance.now() + delay);
    } else bucket.rateLimits = Math.max(0, bucket.rateLimits - 1);
    waiter.log('completed', {
      status: failure ? 'error' : 'success',
      duration_ms: Math.ceil(performance.now() - started),
      cooldown_ms: delay,
      ...failure,
    });
  }

  stats(): Record<
    string,
    { active: number; queued: number; cooldownMs: number; calls: number; errors: number }
  > {
    const result: ReturnType<ToolCallScheduler['stats']> = {};
    for (const [name, bucket] of this.buckets)
      result[name] = {
        active: bucket.active,
        queued: bucket.queue.length,
        calls: bucket.calls,
        errors: bucket.errors,
        cooldownMs: Math.max(0, Math.ceil(bucket.cooldownUntil - performance.now())),
      };
    return result;
  }
}

export const toolCallScheduler = new ToolCallScheduler(
  async (server) => (await getServerDao().findById(server))?.rateLimit,
);
