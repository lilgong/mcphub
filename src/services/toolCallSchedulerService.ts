import { performance } from 'node:perf_hooks';
import type { ToolCallPolicy } from '../types/atlas.js';
import { getCachedSystemConfig } from '../utils/systemConfigCache.js';

interface Waiter {
  server: string;
  call: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
interface Bucket {
  active: number;
  queue: Waiter[];
  lastStarted: number;
  cooldownUntil: number;
  rateLimits: number;
  calls: number;
  errors: number;
  timer?: ReturnType<typeof setTimeout>;
}

export function isUpstreamRateLimit(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as {
    isError?: boolean;
    status?: number;
    statusCode?: number;
    message?: string;
  };
  if (item.status === 429 || item.statusCode === 429) return true;
  if (!(value instanceof Error) && !item.isError) return false;
  const text = value instanceof Error ? value.message : JSON.stringify(value);
  return /http\s*429|429\s+too many|status(?:\s+code|_code)?["':=\s]+429|rate limit exceeded|too many requests/i.test(
    text,
  );
}

/** One FIFO scheduler per service (or personal credential owner), within one Hub process. */
export class ToolCallScheduler {
  private buckets = new Map<string, Bucket>();
  constructor(private policy: (server: string) => ToolCallPolicy | undefined) {}

  run<T>(
    server: string,
    call: () => Promise<T>,
    principal = 'system',
    signal?: AbortSignal,
  ): Promise<T> {
    const policy = this.policy(server);
    if (!policy?.enabled)
      return signal?.aborted ? Promise.reject(new Error('Tool call cancelled')) : call();
    const key = policy.scope === 'principal' ? `${server}\0${principal}` : server;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        active: 0,
        queue: [],
        lastStarted: -Infinity,
        cooldownUntil: 0,
        rateLimits: 0,
        calls: 0,
        errors: 0,
      };
      this.buckets.set(key, bucket);
    }
    if (signal?.aborted) return Promise.reject(new Error('Tool call cancelled'));
    if (bucket.queue.length >= policy.maxQueued)
      return Promise.reject(new Error(`Tool queue is full for '${server}'`));
    const state = bucket;
    return new Promise<T>((resolve, reject) => {
      const remove = (message: string) => {
        const index = state.queue.indexOf(waiter);
        if (index < 0) return;
        state.queue.splice(index, 1);
        waiter.cleanup();
        reject(new Error(message));
        this.pump(state);
      };
      const abort = () => remove('Tool call cancelled while queued');
      const timeout = setTimeout(
        () => remove(`Tool queue wait timed out for '${server}'`),
        policy.queueTimeoutMs,
      );
      const waiter: Waiter = {
        server,
        call,
        resolve: (result) => resolve(result as T),
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      state.queue.push(waiter);
      this.pump(state);
    });
  }

  refresh(): void {
    for (const bucket of this.buckets.values()) this.pump(bucket);
  }

  private pump(bucket: Bucket): void {
    clearTimeout(bucket.timer);
    bucket.timer = undefined;
    while (bucket.queue.length) {
      const waiter = bucket.queue[0];
      const policy = this.policy(waiter.server);
      const limited = policy?.enabled;
      if (limited && bucket.active >= policy.concurrency) return;
      const now = performance.now();
      const ready = limited
        ? Math.max(bucket.lastStarted + policy.minIntervalMs, bucket.cooldownUntil)
        : now;
      if (ready > now) {
        bucket.timer = setTimeout(() => this.pump(bucket), Math.ceil(ready - now));
        return;
      }
      bucket.queue.shift();
      waiter.cleanup();
      bucket.active++;
      bucket.lastStarted = now;
      bucket.calls++;
      Promise.resolve()
        .then(waiter.call)
        .then(
          (result) => {
            this.observe(bucket, policy, result);
            waiter.resolve(result);
          },
          (error: Error) => {
            this.observe(bucket, policy, error);
            waiter.reject(error);
          },
        )
        .finally(() => {
          bucket.active--;
          this.pump(bucket);
        });
    }
  }

  private observe(bucket: Bucket, policy: ToolCallPolicy | undefined, result: unknown): void {
    if (result instanceof Error || (result as { isError?: boolean })?.isError) bucket.errors++;
    if (policy?.enabled && isUpstreamRateLimit(result)) {
      bucket.rateLimits++;
      const delay = Math.min(
        policy.rateLimitBackoffMs * 2 ** Math.min(bucket.rateLimits - 1, 20),
        policy.maxBackoffMs,
      );
      bucket.cooldownUntil = Math.max(bucket.cooldownUntil, performance.now() + delay);
    } else bucket.rateLimits = Math.max(0, bucket.rateLimits - 1);
  }

  stats(): Record<
    string,
    { active: number; queued: number; cooldownMs: number; calls: number; errors: number }
  > {
    const result: Record<
      string,
      { active: number; queued: number; cooldownMs: number; calls: number; errors: number }
    > = {};
    for (const [key, bucket] of this.buckets) {
      const name = key.split('\0')[0];
      const row = (result[name] ??= { active: 0, queued: 0, cooldownMs: 0, calls: 0, errors: 0 });
      row.active += bucket.active;
      row.queued += bucket.queue.length;
      row.calls += bucket.calls;
      row.errors += bucket.errors;
      row.cooldownMs = Math.max(
        row.cooldownMs,
        Math.max(0, Math.ceil(bucket.cooldownUntil - performance.now())),
      );
    }
    return result;
  }
}

export const toolCallScheduler = new ToolCallScheduler(
  (server) => getCachedSystemConfig()?.atlas?.policies[server],
);
