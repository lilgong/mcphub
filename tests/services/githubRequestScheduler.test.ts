import { gzipSync } from 'node:zlib';
jest.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, _value: unknown, options: { signal: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
        reject(options.signal.reason);
      };
      const timer = setTimeout(() => {
        options.signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      options.signal.addEventListener('abort', abort, { once: true });
    }),
}));
import {
  GithubRequestScheduler,
  githubMutation,
  githubRateDelay,
} from '../../src/services/githubRequestSchedulerService.js';
import type { ForwardResponse } from '../../src/services/httpForwardService.js';
import type { GithubThrottleState } from '../../src/services/githubThrottleStore.js';
const reply = (
  status = 200,
  headers: Record<string, string> = {},
  body = '{}',
): ForwardResponse => ({ status, headers, body: Buffer.from(body), isError: status >= 400 });
const identity = async () => reply(200, {}, '{"id":123}');
const options = (
  dispatch: () => Promise<ForwardResponse>,
  extra: Record<string, unknown> = {},
) => ({
  credential: 'token-a',
  url: 'https://api.github.com/user/repos',
  method: 'GET',
  signal: new AbortController().signal,
  identify: identity,
  dispatch,
  ...extra,
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1000000);
});
afterEach(() => jest.useRealTimers());
test('different tokens for the same user share FIFO; independent accounts continue', async () => {
  const queue = new GithubRequestScheduler();
  const calls: string[] = [];
  let unlock!: () => void;
  const first = queue.run(
    options(async () => {
      calls.push('a');
      await new Promise<void>((r) => {
        unlock = r;
      });
      return reply();
    }),
  );
  await jest.advanceTimersByTimeAsync(0);
  const second = queue.run(
    options(
      async () => {
        calls.push('b');
        return reply();
      },
      { credential: 'token-b' },
    ),
  );
  const other = queue.run(
    options(
      async () => {
        calls.push('other');
        return reply();
      },
      { credential: 'token-c', identify: async () => reply(200, {}, '{"id":456}') },
    ),
  );
  await jest.advanceTimersByTimeAsync(0);
  expect(calls).toEqual(['a', 'other']);
  unlock();
  await Promise.all([first, second, other]);
  expect(calls).toEqual(['a', 'other', 'b']);
});
test('writes pause five seconds after completion; intervening reads need no invented interval', async () => {
  const queue = new GithubRequestScheduler();
  const calls: number[] = [];
  await queue.run(options(async () => reply(), { method: 'POST' }));
  const read = queue.run(
    options(async () => {
      calls.push(Date.now());
      return reply();
    }),
  );
  await read;
  const write = queue.run(
    options(
      async () => {
        calls.push(Date.now());
        return reply();
      },
      { method: 'DELETE' },
    ),
  );
  await jest.advanceTimersByTimeAsync(4999);
  expect(calls).toEqual([1000000]);
  await jest.advanceTimersByTimeAsync(1);
  await write;
  expect(calls).toEqual([1000000, 1005000]);
});
test('secondary limits return unchanged; subsequent requests respect the shared cooldown', async () => {
  const queue = new GithubRequestScheduler();
  const limited = {
    ...reply(403, { 'retry-after': '2' }, '{"message":"secondary rate limit"}'),
    rateLimited: true,
  };
  const rejected = jest.fn(async () => limited);
  expect(await queue.run(options(rejected))).toBe(limited);
  expect(rejected).toHaveBeenCalledTimes(1);
  const dispatch = jest.fn(async () => reply());
  const next = queue.run(options(dispatch, { credential: 'token-b' }));
  await jest.advanceTimersByTimeAsync(1999);
  expect(dispatch).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  await next;
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(rejected).toHaveBeenCalledTimes(1);
});

test('remaining zero on success pauses the next request until reset', async () => {
  const queue = new GithubRequestScheduler();
  await queue.run(
    options(async () => reply(200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1005' })),
  );
  const dispatch = jest.fn(async () => reply());
  const next = queue.run(options(dispatch));
  await jest.advanceTimersByTimeAsync(4999);
  expect(dispatch).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  await next;
  expect(dispatch).toHaveBeenCalledTimes(1);
});
test('cancelled waiter does not block or overtake the next request', async () => {
  const queue = new GithubRequestScheduler();
  let unlock!: () => void;
  const order: string[] = [];
  const first = queue.run(
    options(async () => {
      order.push('a');
      await new Promise<void>((r) => {
        unlock = r;
      });
      return reply();
    }),
  );
  await jest.advanceTimersByTimeAsync(0);
  const abort = new AbortController();
  const cancelled = queue.run(
    options(
      async () => {
        order.push('bad');
        return reply();
      },
      { signal: abort.signal },
    ),
  );
  const rejected = expect(cancelled).rejects.toBeDefined();
  abort.abort();
  await rejected;
  const last = queue.run(
    options(async () => {
      order.push('last');
      return reply();
    }),
  );
  await jest.advanceTimersByTimeAsync(0);
  expect(order).toEqual(['a']);
  unlock();
  await Promise.all([first, last]);
  expect(order).toEqual(['a', 'last']);
});
test('ordinary permissions, validation and network failures are not automatically retried', async () => {
  for (const status of [403, 404, 422, 500]) {
    const queue = new GithubRequestScheduler();
    const dispatch = jest.fn(async () => reply(status));
    expect((await queue.run(options(dispatch))).status).toBe(status);
    expect(dispatch).toHaveBeenCalledTimes(1);
  }
  const dispatch = jest.fn(async () => {
    throw new Error('network');
  });
  await expect(new GithubRequestScheduler().run(options(dispatch))).rejects.toThrow('network');
  expect(dispatch).toHaveBeenCalledTimes(1);
});
test('suspended accounts stop queued work; rejected identity never spends another upstream call', async () => {
  const queue = new GithubRequestScheduler();
  const dispatch = jest.fn(async () =>
    reply(403, {}, '{"message":"Sorry. Your account was suspended"}'),
  );
  await queue.run(options(dispatch));
  await queue.run(options(dispatch));
  expect(dispatch).toHaveBeenCalledTimes(1);
  const identify = jest.fn(async () => reply(401));
  const other = new GithubRequestScheduler();
  await other.run(options(dispatch, { identify }));
  await other.run(options(dispatch, { identify }));
  expect(identify).toHaveBeenCalledTimes(1);
});
test('rate-limited requests are forwarded only once', async () => {
  const limited = { ...reply(429, { 'retry-after': '1' }), rateLimited: true };
  const dispatch = jest.fn(async () => limited);
  expect(await new GithubRequestScheduler().run(options(dispatch))).toBe(limited);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('a persisted 32-minute cooldown returns promptly without dispatching or extending it', async () => {
  const state = { cooldownUntil: Date.now() + 1920000, nextWriteAt: 0, failures: 6 };
  const store = {
    identity: async () => '123',
    saveIdentity: jest.fn(),
    load: async () => state,
    save: jest.fn(),
  };
  const queue = new GithubRequestScheduler(store);
  const dispatch = jest.fn(async () => reply());
  const result = await queue.run(options(dispatch));
  expect(result.status).toBe(429);
  expect(result.headers['retry-after']).toBe('1920');
  expect(JSON.parse(result.body.toString()).message).toContain('MCPHub');
  expect(dispatch).not.toHaveBeenCalled();
  expect(store.save).not.toHaveBeenCalled();
  expect((await queue.run(options(dispatch))).status).toBe(429);
  expect(jest.getTimerCount()).toBe(0);
});

test('admission budget includes time already spent in the HTTP gateway', async () => {
  const queue = new GithubRequestScheduler();
  const dispatch = jest.fn(async () => reply());
  const expired = await queue.run(options(dispatch, { queuedAt: Date.now() - 600001 }));
  expect(expired.status).toBe(429);
  expect(dispatch).not.toHaveBeenCalled();
  expect((await queue.run(options(dispatch))).status).toBe(200);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('FIFO admission expires after 10 minutes without truncating an active upstream request', async () => {
  const queue = new GithubRequestScheduler();
  const calls: string[] = [];
  let unlock!: () => void;
  const active = queue.run(
    options(async () => {
      calls.push('active');
      await new Promise<void>((resolve) => {
        unlock = resolve;
      });
      return reply();
    }),
  );
  await jest.advanceTimersByTimeAsync(0);
  const dispatch = jest.fn(async () => reply());
  const expired = queue.run(options(dispatch));
  await jest.advanceTimersByTimeAsync(1000);
  const last = queue.run(
    options(async () => {
      calls.push('last');
      return reply();
    }),
  );
  await jest.advanceTimersByTimeAsync(599000);
  expect((await expired).status).toBe(429);
  expect(dispatch).not.toHaveBeenCalled();
  expect(calls).toEqual(['active']);
  unlock();
  expect((await active).status).toBe(200);
  expect((await last).status).toBe(200);
  expect(calls).toEqual(['active', 'last']);
  expect(jest.getTimerCount()).toBe(0);
});

test('GraphQL reads and Git fetch POSTs are not classified as mutations', () => {
  expect(
    githubMutation(
      'https://api.github.com/graphql',
      'POST',
      Buffer.from('{"query":"query { viewer { login } }"}'),
    ),
  ).toBe(false);
  expect(
    githubMutation(
      'https://api.github.com/graphql',
      'POST',
      Buffer.from('{"query":"mutation { addComment }"}'),
    ),
  ).toBe(true);
  expect(githubMutation('https://github.com/a/b.git/git-upload-pack', 'POST')).toBe(false);
  expect(githubMutation('https://github.com/a/b.git/git-receive-pack', 'POST')).toBe(true);
  expect(githubRateDelay({ ...reply(403), rateLimited: true }, 1, 0)).toBe(60000);
  expect(githubRateDelay({ ...reply(403), rateLimited: true }, 2, 0)).toBe(120000);
});

test('cooldown and account identity survive a scheduler restart without a new identity request', async () => {
  const identities = new Map<string, string>();
  const states = new Map();
  const store = {
    identity: async (key: string) => identities.get(key),
    saveIdentity: async (key: string, id: string) => {
      identities.set(key, id);
    },
    load: async (id: string) => states.get(id),
    save: async (id: string, state: unknown) => {
      states.set(id, { ...(state as object) });
    },
  };
  const first = new GithubRequestScheduler(store);
  await first.run(
    options(async () => reply(200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1005' })),
  );
  const identify = jest.fn(identity);
  const dispatch = jest.fn(async () => reply());
  const restarted = new GithubRequestScheduler(store);
  const next = restarted.run(options(dispatch, { identify }));
  await jest.advanceTimersByTimeAsync(4999);
  expect(dispatch).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  await next;
  expect(identify).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledTimes(1);
});
test('revoking one PAT does not stop another valid PAT for the same GitHub user', async () => {
  const queue = new GithubRequestScheduler();
  await queue.run(options(async () => reply(401)));
  const dispatch = jest.fn(async () => reply());
  await queue.run(options(dispatch, { credential: 'working-token' }));
  expect(dispatch).toHaveBeenCalledTimes(1);
  await queue.run(options(dispatch));
  expect(dispatch).toHaveBeenCalledTimes(1);
});
test('a revoked token also stops requests queued before the revocation response', async () => {
  const queue = new GithubRequestScheduler();
  let finish!: () => void;
  const first = queue.run(
    options(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return reply(401);
    }),
  );
  await jest.advanceTimersByTimeAsync(0);
  const dispatch = jest.fn(async () => reply());
  const second = queue.run(options(dispatch));
  await jest.advanceTimersByTimeAsync(0);
  finish();
  await first;
  expect((await second).status).toBe(401);
  expect(dispatch).not.toHaveBeenCalled();
});
test('both Retry-After and exhausted primary quota are respected', () => {
  expect(
    githubRateDelay(
      {
        ...reply(403, {
          'retry-after': '1',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1010',
        }),
        rateLimited: true,
      },
      1,
      1000000,
    ),
  ).toBe(10000);
});
test('identity rate limits do not generate a new identity lookup per waiting client', async () => {
  const queue = new GithubRequestScheduler();
  const identify = jest.fn(async () => ({
    ...reply(429, { 'retry-after': '2' }),
    rateLimited: true,
  }));
  const dispatch = jest.fn(async () => reply());
  await queue.run(options(dispatch, { identify }));
  await queue.run(options(dispatch, { identify }));
  expect(identify).toHaveBeenCalledTimes(1);
  expect(dispatch).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(2000);
  await queue.run(options(dispatch, { identify }));
  expect(identify).toHaveBeenCalledTimes(2);
});

test('compressed GitHub identity responses retain wire bytes without breaking account scheduling', async () => {
  const queue = new GithubRequestScheduler();
  const dispatch = jest.fn(async () => reply());
  const compressed = {
    ...reply(200, { 'content-encoding': 'gzip' }),
    body: gzipSync(Buffer.from('{"id":123}')),
  };
  const result = await queue.run(options(dispatch, { identify: async () => compressed }));
  expect(result.status).toBe(200);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('identity lookup uses the admission deadline without dispatching the original request', async () => {
  const queue = new GithubRequestScheduler();
  let identify!: (result: ForwardResponse) => void;
  const dispatch = jest.fn(async () => reply());
  const result = queue.run(
    options(dispatch, {
      identify: () =>
        new Promise<ForwardResponse>((resolve) => {
          identify = resolve;
        }),
    }),
  );
  await jest.advanceTimersByTimeAsync(600000);
  expect((await result).status).toBe(429);
  expect(dispatch).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  identify(reply(200, {}, '{"id":123}'));
  await jest.advanceTimersByTimeAsync(0);
  expect((await queue.run(options(dispatch))).status).toBe(200);
});

test('loading saved state is covered by the admission deadline', async () => {
  let load!: (state: undefined) => void;
  const queue = new GithubRequestScheduler({
    identity: async () => '123',
    saveIdentity: jest.fn(),
    load: () =>
      new Promise((resolve) => {
        load = resolve;
      }),
    save: jest.fn(),
  });
  const dispatch = jest.fn(async () => reply());
  const result = queue.run(options(dispatch));
  await jest.advanceTimersByTimeAsync(600000);
  expect((await result).status).toBe(429);
  expect(dispatch).not.toHaveBeenCalled();
  load(undefined);
  await jest.advanceTimersByTimeAsync(0);
  expect((await queue.run(options(dispatch))).status).toBe(200);
});

test('failed state reads can recover on the next request', async () => {
  const load = jest
    .fn()
    .mockRejectedValueOnce(new Error('database unavailable'))
    .mockResolvedValue(undefined);
  const queue = new GithubRequestScheduler({
    identity: async () => '123',
    saveIdentity: jest.fn(),
    load,
    save: jest.fn(),
  });
  const dispatch = jest.fn(async () => reply());
  await expect(queue.run(options(dispatch))).rejects.toThrow('database unavailable');
  expect((await queue.run(options(dispatch))).status).toBe(200);
  expect(load).toHaveBeenCalledTimes(2);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('expired admission never starts an identity request', async () => {
  const identify = jest.fn(identity);
  const dispatch = jest.fn(async () => reply());
  const result = await new GithubRequestScheduler().run(
    options(dispatch, {
      identify,
      queuedAt: Date.now() - 600001,
    }),
  );
  expect(result.status).toBe(429);
  expect(identify).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test('client cancellation while resolving identity remains cancellation', async () => {
  const controller = new AbortController();
  const queue = new GithubRequestScheduler();
  const result = queue.run(
    options(async () => reply(), {
      signal: controller.signal,
      identify: () => new Promise(() => {}),
    }),
  );
  const rejected = expect(result).rejects.toThrow('caller cancelled');
  await jest.advanceTimersByTimeAsync(0);
  controller.abort(new Error('caller cancelled'));
  await rejected;
  expect(jest.getTimerCount()).toBe(0);
});

test('admission expiry aborts the identity HTTP request and a later lookup can recover', async () => {
  const queue = new GithubRequestScheduler();
  let identitySignal!: AbortSignal;
  const identify = jest.fn((signal: AbortSignal) => {
    identitySignal = signal;
    return new Promise<ForwardResponse>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const dispatch = jest.fn(async () => reply());
  const result = queue.run(options(dispatch, { identify }));
  await jest.advanceTimersByTimeAsync(600000);
  expect((await result).status).toBe(429);
  expect(identitySignal.aborted).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  expect((await queue.run(options(dispatch))).status).toBe(200);
  expect(jest.getTimerCount()).toBe(0);
});

test('the hourly write budget is shared across tokens while reads and other accounts remain usable', async () => {
  const started = Date.now();
  const store = {
    identity: async () => undefined,
    saveIdentity: jest.fn(),
    load: async (id: string) =>
      id === '123'
        ? {
            cooldownUntil: 0,
            nextWriteAt: 0,
            failures: 0,
            writeTimes: [started - 3590000, started - 3580000],
          }
        : undefined,
    save: jest.fn(),
  };
  const queue = new GithubRequestScheduler(store, { intervalMs: 1000, maxPerHour: 2 });
  const write = jest.fn(async () => reply());
  const waiting = queue.run(options(write, { method: 'POST' }));
  await jest.advanceTimersByTimeAsync(9999);
  expect(write).not.toHaveBeenCalled();
  const other = await queue.run(
    options(async () => reply(), {
      credential: 'other-account',
      method: 'POST',
      identify: async () => reply(200, {}, '{"id":456}'),
    }),
  );
  expect(other.status).toBe(200);
  await jest.advanceTimersByTimeAsync(1);
  await waiting;
  expect(write).toHaveBeenCalledTimes(1);
  const read = jest.fn(async () => reply());
  await queue.run(options(read, { credential: 'token-b' }));
  expect(read).toHaveBeenCalledTimes(1);
  const next = queue.run(options(write, { method: 'DELETE', credential: 'token-b' }));
  await jest.advanceTimersByTimeAsync(9999);
  expect(write).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  await next;
  expect(write).toHaveBeenCalledTimes(2);
});

test('full write budgets survive restart and fail promptly without changing upstream cooldown', async () => {
  const state = { cooldownUntil: 0, nextWriteAt: 0, failures: 0, writeTimes: [] as number[] };
  const store = {
    identity: async () => '123',
    saveIdentity: jest.fn(),
    load: async () => structuredClone(state),
    save: jest.fn(async (_id: string, value: GithubThrottleState) => {
      Object.assign(state, structuredClone(value));
    }),
  };
  const first = new GithubRequestScheduler(store, { intervalMs: 1000, maxPerHour: 1 });
  expect((await first.run(options(async () => reply(422), { method: 'POST' }))).status).toBe(422);
  const restarted = new GithubRequestScheduler(store, { intervalMs: 1000, maxPerHour: 1 });
  const dispatch = jest.fn(async () => reply());
  const limited = await restarted.run(options(dispatch, { method: 'POST', credential: 'token-b' }));
  expect(limited.status).toBe(429);
  expect(limited.headers['retry-after']).toBe('3600');
  expect(dispatch).not.toHaveBeenCalled();
  expect(state.cooldownUntil).toBe(0);
  expect(state.failures).toBe(0);
  expect(state.writeTimes).toHaveLength(1);
  expect((await restarted.run(options(dispatch))).status).toBe(200);
  expect(jest.getTimerCount()).toBe(0);
});

test('a cancelled write waiting on the hourly budget is not dispatched or counted', async () => {
  const start = Date.now();
  const state = { cooldownUntil: 0, nextWriteAt: 0, failures: 0, writeTimes: [start - 3590000] };
  const store = {
    identity: async () => '123',
    saveIdentity: jest.fn(),
    load: async () => state,
    save: jest.fn(),
  };
  const queue = new GithubRequestScheduler(store, { intervalMs: 1000, maxPerHour: 1 });
  const controller = new AbortController();
  const dispatch = jest.fn(async () => reply());
  const waiting = queue.run(options(dispatch, { method: 'POST', signal: controller.signal }));
  const cancelled = expect(waiting).rejects.toThrow('cancelled');
  await jest.advanceTimersByTimeAsync(1000);
  controller.abort(new Error('cancelled'));
  await cancelled;
  expect(dispatch).not.toHaveBeenCalled();
  expect(store.save).not.toHaveBeenCalled();
  const next = queue.run(options(dispatch, { method: 'POST' }));
  await jest.advanceTimersByTimeAsync(9000);
  expect((await next).status).toBe(200);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('known exhausted write budget returns before waiting behind another request', async () => {
  const state = {
    cooldownUntil: 0,
    nextWriteAt: 0,
    failures: 0,
    writeTimes: [Date.now()],
  };
  const queue = new GithubRequestScheduler(
    {
      identity: async () => '123',
      saveIdentity: jest.fn(),
      load: async () => state,
      save: jest.fn(),
    },
    { intervalMs: 5000, maxPerHour: 1 },
  );
  let unlock!: () => void;
  const active = queue.run(
    options(
      () =>
        new Promise<ForwardResponse>((resolve) => {
          unlock = () => resolve(reply());
        }),
    ),
  );
  await jest.advanceTimersByTimeAsync(0);
  const dispatch = jest.fn(async () => reply());
  const denied = await queue.run(options(dispatch, { method: 'POST' }));
  expect(denied.status).toBe(429);
  expect(denied.headers['retry-after']).toBe('3600');
  expect(dispatch).not.toHaveBeenCalled();
  unlock();
  expect((await active).status).toBe(200);
  expect((await queue.run(options(dispatch))).status).toBe(200);
  expect(jest.getTimerCount()).toBe(0);
});
