import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getYibuStats } from '../../src/services/yibuStatsService.js';

const id = '0123456789abcdef';
const second = 'fedcba9876543210';
const ts = '2026-11-06T05:00:00Z';
const query = { start: '2026-11-01T00:00:00.000Z', end: '2026-11-30T23:59:59.999Z' };
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
let root: string;
let old: NodeJS.ProcessEnv;
beforeEach(async () => {
  old = { ...process.env };
  root = await mkdtemp(join(tmpdir(), 'yibu-stats-'));
  process.env.MCPHUB_AUDIT_LOG_DIR = join(root, 'audit');
  process.env.MCP_USAGE_LOG_DIR = join(root, 'usage');
  process.env.MCPHUB_USAGE_STATS_DIR = join(root, 'stats');
  await mkdir(join(root, 'audit'));
});
afterEach(async () => {
  process.env = old;
  await rm(root, { recursive: true, force: true });
});
const http = (request: string, server = 'serper-a') => ({
  event: 'upstream_finished',
  ts,
  server,
  upstream_request_id: request,
  upstream_host: 'yibuapi.com',
  http_status: 200,
  upstream_credentials: JSON.stringify([
    { id, suffix: 'abcd' },
    { id, suffix: 'abcd' },
  ]),
});

test('counts seven Yibu providers by month, actual key and scoped MCP; excludes official and unsent calls', async () => {
  for (const [service, name] of Object.entries({
    brave: 'brave-search',
    exa: 'exa',
    oxylabs: 'oxylabs',
    lara: 'lara-translate',
    weatherapi: 'weather-data',
  })) {
    const dir = join(root, 'usage', 'catalogs', 'atlas', name, '2026-11');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${service}_20261106.jsonl`),
      jsonl([
        {
          event: 'finished',
          ts,
          service,
          request_id: service,
          credential_id: id,
          status: service === 'exa' ? 500 : 200,
        },
        { event: 'started', ts, service, request_id: 'unsent', credential_id: id },
      ]),
    );
  }
  await writeFile(
    join(root, 'audit', '2026-11-06.jsonl'),
    jsonl([
      http('one'),
      http('one'),
      http('two', 'jina-reader'),
      {
        ...http('new-key'),
        upstream_credentials: JSON.stringify([{ id: second, suffix: 'efgh' }]),
      },
      { ...http('official'), upstream_host: 'google.serper.dev' },
      { ...http('unsent'), event: 'upstream_started' },
      { ...http('older'), ts: '2026-10-31T20:00:00Z' },
    ]),
  );
  const result = await getYibuStats(query);
  expect(result.total).toBe(8);
  expect(result.errors).toBe(1);
  expect(result.keyRows).toHaveLength(8);
  expect(result.keyRows.find((row) => row.server === 'atlas::exa')).toMatchObject({
    credentialId: id,
    calls: 1,
    errors: 1,
  });
  expect((await getYibuStats({ ...query, credentialId: id })).total).toBe(7);
  expect((await getYibuStats({ ...query, server: ' SERPER ' })).total).toBe(2);
  expect((await getYibuStats({ ...query, catalog: 'atlas' })).total).toBe(5);
  expect((await getYibuStats({ ...query, start: '2026-11-07T00:00:00.000Z' })).total).toBe(0);
  expect(
    (await getYibuStats({ start: '2026-10-01T00:00:00.000Z', end: '2026-10-31T23:59:59.999Z' }))
      .total,
  ).toBe(1);
  const index = await readFile(join(root, 'stats', '2026-11.json'), 'utf8');
  expect(index).not.toContain('upstream_credentials');
  expect(JSON.parse(index).seen).toHaveLength(8);
});

test('incrementally imports appended data, survives copied/rotated/removed logs and preserves totals across reads', async () => {
  const file = join(root, 'audit', '2026-11-06.jsonl');
  await writeFile(file, jsonl([http('one')]));
  expect((await getYibuStats(query)).total).toBe(1);
  await appendFile(file, JSON.stringify(http('two')).slice(0, 30));
  expect((await getYibuStats(query)).total).toBe(1);
  await appendFile(file, JSON.stringify(http('two')).slice(30) + '\n');
  expect((await getYibuStats(query)).total).toBe(2);
  await writeFile(join(root, 'audit', '2026-11-07.jsonl'), jsonl([http('two')]));
  expect((await getYibuStats(query)).total).toBe(2);
  await writeFile(file, jsonl([http('replacement')]));
  expect((await getYibuStats(query)).total).toBe(3);
  await rm(join(root, 'audit'), { recursive: true });
  expect((await getYibuStats(query)).total).toBe(3);
  expect((await getYibuStats(query)).total).toBe(3);
});

test('deduplicates repeated credential roles, keeps unknown keys visible and counts multi-key requests once in the total', async () => {
  await writeFile(
    join(root, 'audit', '2026-11-06.jsonl'),
    jsonl([
      http('one'),
      { ...http('two'), upstream_credentials: JSON.stringify([{ id }, { id: second }]) },
      { ...http('three'), upstream_credentials: '[]', http_status: 429 },
    ]),
  );
  const result = await getYibuStats(query);
  expect(result.total).toBe(3);
  expect(result.errors).toBe(1);
  expect(result.keyRows.find((row) => row.credentialId === id)?.calls).toBe(2);
  expect(result.keyRows.find((row) => row.credentialId === second)?.calls).toBe(1);
  expect(result.keyRows.find((row) => row.credentialId === '')?.errors).toBe(1);
  expect((await getYibuStats({ ...query, credentialId: second })).total).toBe(1);
});

test('serializes concurrent indexing without double counting', async () => {
  await writeFile(join(root, 'audit', '2026-11-06.jsonl'), jsonl([http('one')]));
  const results = await Promise.all(Array.from({ length: 5 }, () => getYibuStats(query)));
  expect(results.map((result) => result.total)).toEqual([1, 1, 1, 1, 1]);
});

test('persists matched suffixes so later key rotation does not remove historical labels', async () => {
  const file = join(root, 'audit', '2026-11-06.jsonl');
  await writeFile(
    file,
    jsonl([{ ...http('one'), upstream_credentials: JSON.stringify([{ id }]) }]),
  );
  expect((await getYibuStats(query, new Map([[id, 'abcd']]))).keyRows[0].credentialSuffix).toBe(
    'abcd',
  );
  await rm(join(root, 'audit'), { recursive: true });
  expect((await getYibuStats(query)).keyRows[0].credentialSuffix).toBe('abcd');
});

test('local calendar days and months include UTC boundary requests exactly once without changing UTC rollups', async () => {
  await writeFile(
    join(root, 'audit', '2026-10-31.jsonl'),
    jsonl([
      { ...http('before'), ts: '2026-10-31T15:59:59.999Z' },
      { ...http('first'), ts: '2026-10-31T16:00:00.000Z' },
      { ...http('first'), ts: '2026-10-31T16:00:00.000Z' },
    ]),
  );
  await writeFile(
    join(root, 'audit', '2026-11-01.jsonl'),
    jsonl([
      { ...http('last'), ts: '2026-11-01T15:59:59.999Z' },
      { ...http('after'), ts: '2026-11-01T16:00:00.000Z' },
      { ...http('official'), ts: '2026-11-01T00:00:00Z', upstream_host: 'google.serper.dev' },
    ]),
  );
  const local = {
    start: '2026-10-31T16:00:00.000Z',
    end: '2026-11-01T15:59:59.999Z',
    timeZone: 'Asia/Shanghai',
  };
  const result = await getYibuStats(local);
  expect(result.total).toBe(2);
  expect(result.keyRows[0]).toMatchObject({ credentialId: id, calls: 2 });
  expect((await getYibuStats(local)).total).toBe(2);
  expect(
    (await getYibuStats({ start: '2026-10-31T00:00:00.000Z', end: '2026-10-31T23:59:59.999Z' }))
      .total,
  ).toBe(2);
});

test('a 25-hour DST day retains both repeated hours and all credential counts', async () => {
  await writeFile(
    join(root, 'audit', '2026-11-01.jsonl'),
    jsonl([
      { ...http('early'), ts: '2026-11-01T03:59:59.999Z' },
      { ...http('start'), ts: '2026-11-01T04:00:00.000Z' },
      { ...http('hour1'), ts: '2026-11-01T05:30:00.000Z' },
      { ...http('hour2'), ts: '2026-11-01T06:30:00.000Z' },
    ]),
  );
  await writeFile(
    join(root, 'audit', '2026-11-02.jsonl'),
    jsonl([
      { ...http('end'), ts: '2026-11-02T04:59:59.999Z' },
      { ...http('late'), ts: '2026-11-02T05:00:00.000Z' },
    ]),
  );
  const result = await getYibuStats({
    start: '2026-11-01T04:00:00.000Z',
    end: '2026-11-02T04:59:59.999Z',
    timeZone: 'America/New_York',
    credentialId: id,
  });
  expect(result.total).toBe(4);
  expect(result.keyRows[0].calls).toBe(4);
});

test('retains rotated key labels across months, MCP filters and archived raw logs without changing counts', async () => {
  await writeFile(
    join(root, 'audit', '2026-10-31.jsonl'),
    jsonl([{ ...http('historical-label'), ts: '2026-10-20T05:00:00Z' }]),
  );
  const usage = join(root, 'usage', 'catalogs', 'atlas', 'exa', '2026-11');
  await mkdir(usage, { recursive: true });
  await writeFile(
    join(usage, 'exa_20261106.jsonl'),
    jsonl([
      {
        event: 'finished',
        ts,
        service: 'exa',
        request_id: 'legacy-key',
        credential_id: id,
        status: 200,
      },
      {
        event: 'finished',
        ts,
        service: 'exa',
        request_id: 'different-key',
        credential_id: second,
        status: 200,
      },
    ]),
  );
  const filtered = { ...query, catalog: 'atlas', server: 'exa' };
  let result = await getYibuStats(filtered);
  expect(result.total).toBe(2);
  expect(result.keyRows.find((row) => row.credentialId === id)?.credentialSuffix).toBe('abcd');
  expect(
    result.keyRows.find((row) => row.credentialId === second)?.credentialSuffix,
  ).toBeUndefined();
  await rm(join(root, 'audit'), { recursive: true });
  await rm(join(root, 'usage'), { recursive: true });
  result = await getYibuStats(filtered);
  expect(result.total).toBe(2);
  expect(result.keyRows.find((row) => row.credentialId === id)?.credentialSuffix).toBe('abcd');
  // Older installations already have summaries and cursors; bootstrap without rescanning raw logs.
  await rm(join(root, 'stats', 'key-suffixes.json'));
  result = await getYibuStats(filtered);
  expect(result.total).toBe(2);
  expect(result.keyRows.find((row) => row.credentialId === id)?.credentialSuffix).toBe('abcd');
});
