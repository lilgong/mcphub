import {
  ToolCallScheduler,
  isUpstreamRateLimit,
} from '../../src/services/toolCallSchedulerService.js';
import type { ServiceRateLimit as ToolCallPolicy } from '../../src/types/serviceControls.js';

const base: ToolCallPolicy = {
  enabled: true,
  concurrency: 1,
  minIntervalMs: 0,
  maxQueued: 2,
  queueTimeoutMs: 1000,
  rateLimitBackoffMs: 35,
  maxBackoffMs: 70,
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

  test('all credential owners share limits and hot disabling drains queued calls', async () => {
    let policy = { ...base };
    const scheduler = new ToolCallScheduler(() => policy);
    let release!: () => void;
    const first = scheduler.run(
      'brave',
      async () => new Promise<void>((resolve) => (release = resolve)),
      'alice',
    );
    const queued = scheduler.run('brave', async () => 'second', 'alice');
    const bob = scheduler.run('brave', async () => 'bob', 'bob');
    await pause(1);
    expect(scheduler.stats().brave.queued).toBe(2);
    policy = { ...policy, enabled: false };
    scheduler.refresh();
    await expect(queued).resolves.toBe('second');
    await expect(bob).resolves.toBe('bob');
    release();
    await first;
    await pause(1);
    expect(scheduler.stats().brave.active).toBe(0);
  });

  test('limits a rolling window across clients without adding a concurrency cap', async () => {
    const scheduler = new ToolCallScheduler(() => ({ enabled: true, maxCalls: 2, windowMs: 50 }));
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        scheduler.run('api', async () => starts.push(performance.now()), String(i)),
      ),
    );
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(45);
  });

  test('unset concurrency allows parallel calls', async () => {
    const scheduler = new ToolCallScheduler(() => ({ enabled: true }));
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        scheduler.run('api', async () => {
          peak = Math.max(peak, ++active);
          await pause(10);
          active--;
        }),
      ),
    );
    expect(peak).toBe(4);
  });

  test('cancellation during async policy loading never dispatches the removed head', async () => {
    const scheduler = new ToolCallScheduler(async () => {
      await pause(5);
      return base;
    });
    const signal = new AbortController();
    const call = jest.fn(async () => undefined);
    const pending = scheduler.run('api', call, 'alice', signal.signal);
    const check = expect(pending).rejects.toThrow('cancelled');
    await pause(7);
    signal.abort();
    await check;
    await pause(10);
    expect(call).not.toHaveBeenCalled();
  });

  test('does not interpret successful data containing 429 as a provider failure', () => {
    expect(isUpstreamRateLimit({ content: [{ text: 'HTTP 429' }] })).toBe(false);
    expect(isUpstreamRateLimit(new Error('HTTP 429'))).toBe(true);
    expect(isUpstreamRateLimit({ isError: true, content: [{ text: 'rate limit exceeded' }] })).toBe(
      true,
    );
  });
});
