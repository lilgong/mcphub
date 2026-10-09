import {
  KeyPoolService,
  classifyKeyResponse,
  authenticateKeyPool,
  keyPoolToken,
} from '../../src/services/keyPoolService.js';
import { normalizeKeyPool } from '../../src/utils/keyPool.js';
import type { KeyPoolConfig, KeyPoolResponse } from '../../src/types/keyPool.js';
const keys = [1, 2, 3].map((index) => ({
  id: `key-${index}`,
  label: `label-${index}`,
  value: `private-${index}`,
}));
const target = 'https://context7.com/api/v2/search?query=test';
const ok: KeyPoolResponse = { status: 200, headers: {}, body: '{"results":[]}' };
const quota: KeyPoolResponse = {
  status: 429,
  headers: {},
  body: '{"message":"Monthly quota reached"}',
};
const signal = () => new AbortController().signal;
describe('key pool scheduling', () => {
  let pool: KeyPoolConfig;
  let now: number;
  let send: jest.Mock;
  let audit: jest.Mock;
  let service: KeyPoolService;
  beforeEach(() => {
    pool = { enabled: true, provider: 'context7', keys: structuredClone(keys) };
    now = Date.parse('2026-10-09T12:00:00Z');
    send = jest.fn().mockResolvedValue(ok);
    audit = jest.fn();
    service = new KeyPoolService(
      async () => pool,
      send,
      audit,
      () => now,
    );
  });
  test('round robin shared by concurrent callers, without modifying the keys', async () => {
    await Promise.all(
      Array.from({ length: 6 }, () => service.request('context7', target, signal())),
    );
    expect(send.mock.calls.map((call) => call[1].Authorization)).toEqual([
      'Bearer private-1',
      'Bearer private-2',
      'Bearer private-3',
      'Bearer private-1',
      'Bearer private-2',
      'Bearer private-3',
    ]);
    expect(pool.keys).toEqual(keys);
    expect(audit.mock.calls.filter((call) => call[0] === 'finished')).toHaveLength(6);
    expect(JSON.stringify(audit.mock.calls)).not.toContain('private-');
  });
  test('hides quota and auth failures and skips cooling keys on later requests', async () => {
    send
      .mockResolvedValueOnce(quota)
      .mockResolvedValueOnce({ status: 401, headers: {}, body: '{}' });
    expect(await service.request('context7', target, signal())).toEqual(ok);
    expect(send).toHaveBeenCalledTimes(3);
    await service.request('context7', target, signal());
    expect(send.mock.calls[3][1].Authorization).toBe('Bearer private-3');
    now += 61000;
    await service.request('context7', target, signal());
    expect(send.mock.calls[4][1].Authorization).toBe('Bearer private-2');
    expect(pool.keys).toHaveLength(3);
  });
  test('all exhausted returns a fatal error, daily/monthly keys participate after reset', async () => {
    send.mockResolvedValue(quota);
    const result = await service.request('context7', target, signal());
    expect(result.status).toBe(402);
    expect(JSON.parse(result.body).message).toMatch(/^Error:.*quota exhausted/);
    expect(send).toHaveBeenCalledTimes(3);
    await service.request('context7', target, signal());
    expect(send).toHaveBeenCalledTimes(3);
    now = Date.parse('2026-11-01T00:00:01Z');
    send.mockResolvedValue(ok);
    expect((await service.request('context7', target, signal())).status).toBe(200);
  });
  test('temporary rate limits use Retry-After and never claim account exhaustion', async () => {
    send.mockResolvedValue({ status: 429, headers: { 'retry-after': '10' }, body: '{}' });
    expect((await service.request('context7', target, signal())).status).toBe(429);
    now += 11000;
    send.mockResolvedValue(ok);
    expect((await service.request('context7', target, signal())).status).toBe(200);
  });
  test('does not retry parameter, permission, missing-document or network errors', async () => {
    for (const status of [400, 403, 404, 500]) {
      send.mockResolvedValue({ status, headers: {}, body: '{}' });
      expect((await service.request('context7', target, signal())).status).toBe(status);
    }
    expect(send).toHaveBeenCalledTimes(4);
    send.mockRejectedValueOnce(new Error('private-1 authenticated URL'));
    await expect(service.request('context7', target, signal())).rejects.toThrow(
      'Key pool upstream network failure',
    );
    expect(send).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(audit.mock.calls)).not.toContain('private-1');
  });
  test('updated keys take effect on the next request and clear that key cooldown', async () => {
    send.mockResolvedValue(quota);
    await service.request('context7', target, signal());
    pool.keys[0].value = 'replaced-key';
    send.mockResolvedValue(ok);
    await service.request('context7', target, signal());
    expect(send.mock.calls.at(-1)![1].Authorization).toBe('Bearer replaced-key');
  });
  test('cannot use credentials when audit admission fails, or after cancellation', async () => {
    audit.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(service.request('context7', target, signal())).rejects.toThrow('disk full');
    expect(send).not.toHaveBeenCalled();
    const abort = new AbortController();
    abort.abort();
    await expect(service.request('context7', target, abort.signal)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  test('fixed destinations reject redirects/SSRF-shaped targets and strip legacy keys', async () => {
    for (const url of [
      'http://context7.com/api/v2/search',
      'https://127.0.0.1/api/test',
      'https://context7.com:444/api/test',
      'https://user:secret@context7.com/api/test',
      'https://context7.com/not-api',
    ])
      await expect(service.request('context7', url, signal())).rejects.toThrow('Unsupported');
    expect(send).not.toHaveBeenCalled();
    await service.request('context7', target + '&apikey=legacy-private', signal());
    expect(send.mock.calls[0][0].searchParams.has('apikey')).toBe(false);
  });
  test('TwelveData injects query keys and rotates on errors embedded in HTTP 200', async () => {
    pool.provider = 'twelvedata';
    send.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: '{"status":"error","code":429,"message":"You have run out of API credits for the day"}',
    });
    await service.request(
      'twelvedata',
      'https://api.twelvedata.com/price?symbol=AAPL&apikey=old-secret',
      signal(),
    );
    expect(send.mock.calls.map((call) => call[0].searchParams.get('apikey'))).toEqual([
      'private-1',
      'private-2',
    ]);
    expect(send.mock.calls[0][1]).toEqual({});
    expect(audit.mock.calls[1][1]).toMatchObject({
      http_status: 200,
      provider_status: 429,
      category: 'quota_exhausted',
      retry_at: '2026-10-10T00:00:00.000Z',
    });
  });
  test('TwelveData supports nested API paths and ambiguous 429s stay recoverable', async () => {
    pool.provider = 'twelvedata';
    await service.request('twelvedata', 'https://api.twelvedata.com/funds/world', signal());
    expect(send.mock.calls[0][0].pathname).toBe('/funds/world');
    const result = classifyKeyResponse(
      'context7',
      { status: 429, headers: {}, body: '{"message":"Rate limited or quota exceeded"}' },
      now,
    );
    expect(result.reason).toBe('rate_limit');
  });
  test('ordinary documentation containing quota words is never treated as exhaustion', () => {
    expect(
      classifyKeyResponse(
        'context7',
        { ...ok, body: '{"message":"monthly quota exceeded examples"}' },
        now,
      ).reason,
    ).toBeUndefined();
  });
  test('capabilities are per-server and reject unknown and non-ASCII tokens', () => {
    const token = keyPoolToken('alpha');
    expect(authenticateKeyPool('alpha', token)).toBe(true);
    expect(authenticateKeyPool('beta', token)).toBe(false);
    expect(authenticateKeyPool('alpha', 'é'.repeat(token.length))).toBe(false);
  });
  test('validates unique keys and IDs without including secret values in errors', () => {
    expect(normalizeKeyPool(pool)).toEqual({
      ...pool,
      keys: pool.keys.map((key) => ({ ...key, label: `…${key.value.slice(-6)}` })),
    });
    expect(() =>
      normalizeKeyPool({ ...pool, keys: [keys[0], { ...keys[1], value: keys[0].value }] }),
    ).toThrow('unique');
    expect(() => normalizeKeyPool({ ...pool, keys: [] })).toThrow('Invalid');
  });
});
