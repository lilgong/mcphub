import {
  ToolCallScheduler,
  isUpstreamRateLimit,
} from '../../src/services/toolCallSchedulerService.js';
import type { ToolCallPolicy } from '../../src/types/atlas.js';

const base: ToolCallPolicy = {
  enabled: true,
  concurrency: 1,
  minIntervalMs: 0,
  maxQueued: 2,
  queueTimeoutMs: 1000,
  rateLimitBackoffMs: 35,
  maxBackoffMs: 70,
  scope: 'server',
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('per-MCP scheduling', () => {
  test('shares FIFO and concurrency across callers but isolates servers', async () => {
    const scheduler = new ToolCallScheduler(() => base);
    let release!: () => void;
    const order: string[] = [];
    const first = scheduler.run('brave', async () => {
      order.push('first');
      await new Promise<void>((resolve) => (release = resolve));
    });
    const second = scheduler.run(
      'brave',
      async () => {
        order.push('second');
      },
      'alice',
    );
    const third = scheduler.run(
      'brave',
      async () => {
        order.push('third');
      },
      'bob',
    );
    await scheduler.run('exa', async () => order.push('exa'));
    expect(order).toEqual(['first', 'exa']);
    expect(scheduler.stats().brave).toMatchObject({ active: 1, queued: 2 });
    await expect(scheduler.run('brave', async () => {})).rejects.toThrow('full');
    release();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first', 'exa', 'second', 'third']);
  });

  test('paces starts and cools down after 429 without retrying the failed operation', async () => {
    const policy = { ...base, minIntervalMs: 20 };
    const scheduler = new ToolCallScheduler(() => policy);
    const starts: number[] = [];
    const failure = scheduler.run('brave', async () => {
      starts.push(performance.now());
      return { isError: true, content: [{ text: 'HTTP 429 Too Many Requests' }] };
    });
    const next = scheduler.run('brave', async () => starts.push(performance.now()));
    await Promise.all([failure, next]);
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(30);
  });

  test('removes cancelled and expired waiters without calling upstream', async () => {
    const scheduler = new ToolCallScheduler(() => ({ ...base, queueTimeoutMs: 25 }));
    let release!: () => void;
    const first = scheduler.run(
      'brave',
      async () => new Promise<void>((resolve) => (release = resolve)),
    );
    const call = jest.fn(async () => {});
    const controller = new AbortController();
    const cancelled = scheduler.run('brave', call, 'system', controller.signal);
    const expired = scheduler.run('brave', call);
    const cancelledCheck = expect(cancelled).rejects.toThrow('cancelled');
    const expiredCheck = expect(expired).rejects.toThrow('timed out');
    controller.abort();
    await Promise.all([cancelledCheck, expiredCheck]);
    expect(call).not.toHaveBeenCalled();
    release();
    await first;
  });

  test('personal credential owners get independent queues and hot disabling drains queued calls', async () => {
    let policy = { ...base, scope: 'principal' as const };
    const scheduler = new ToolCallScheduler(() => policy);
    let release!: () => void;
    const first = scheduler.run(
      'brave',
      async () => new Promise<void>((resolve) => (release = resolve)),
      'alice',
    );
    const queued = scheduler.run('brave', async () => 'second', 'alice');
    await expect(scheduler.run('brave', async () => 'bob', 'bob')).resolves.toBe('bob');
    policy = { ...policy, enabled: false };
    scheduler.refresh();
    await expect(queued).resolves.toBe('second');
    release();
    await first;
    await pause(1);
    expect(scheduler.stats().brave.active).toBe(0);
  });

  test('does not interpret successful data containing 429 as a provider failure', () => {
    expect(isUpstreamRateLimit({ content: [{ text: 'HTTP 429' }] })).toBe(false);
    expect(isUpstreamRateLimit(new Error('HTTP 429'))).toBe(true);
    expect(isUpstreamRateLimit({ isError: true, content: [{ text: 'rate limit exceeded' }] })).toBe(
      true,
    );
  });
});
