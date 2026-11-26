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
test('writes pause one second after completion; intervening reads need no invented interval', async () => {
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
  await jest.advanceTimersByTimeAsync(999);
  expect(calls).toEqual([1000000]);
  await jest.advanceTimersByTimeAsync(1);
  await write;
  expect(calls).toEqual([1000000, 1001000]);
});
test('secondary limits pause the shared queue and retry only the rejected request', async () => {
  const queue = new GithubRequestScheduler();
  let attempts = 0;
  const order: string[] = [];
  const first = queue.run(
    options(async () => {
      order.push('a');
      return ++attempts === 1
        ? {
            ...reply(403, { 'retry-after': '2' }, '{"message":"secondary rate limit"}'),
            rateLimited: true,
          }
        : reply();
    }),
  );
  const second = queue.run(
    options(
      async () => {
        order.push('b');
        return reply();
      },
      { credential: 'token-b' },
    ),
  );
  await jest.advanceTimersByTimeAsync(1999);
  expect(order).toEqual(['a']);
  await jest.advanceTimersByTimeAsync(1);
  await Promise.all([first, second]);
  expect(order).toEqual(['a', 'a', 'b']);
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
test('retry budget is bounded; streamed packs are not replayed', async () => {
  const limited = { ...reply(429, { 'retry-after': '1' }), rateLimited: true };
  const dispatch = jest.fn(async () => limited);
  const result = new GithubRequestScheduler().run(options(dispatch));
  await jest.advanceTimersByTimeAsync(2000);
  expect((await result).status).toBe(429);
  expect(dispatch).toHaveBeenCalledTimes(3);
  dispatch.mockClear();
  await new GithubRequestScheduler().run(options(dispatch, { streaming: true }));
  expect(dispatch).toHaveBeenCalledTimes(1);
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
