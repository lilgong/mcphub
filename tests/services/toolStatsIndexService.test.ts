import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { appendFile, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCallStats } from '../../src/services/callStatsService.js';

const jsonl = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const query = { start: '2026-11-01T00:00:00.000Z', end: '2026-11-30T23:59:59.999Z' };
const call = (id: string, fields: object = {}) => ({
  event: 'finished',
  request_id: id,
  ts: '2026-11-22T12:00:00.000Z',
  server: 'atlas::google-maps',
  status: 'success',
  duration_ms: 100,
  ...fields,
});
let root: string;
let old: NodeJS.ProcessEnv;
beforeEach(async () => {
  old = { ...process.env };
  root = await mkdtemp(join(tmpdir(), 'tool-stats-index-'));
  process.env.MCPHUB_AUDIT_LOG_DIR = root;
  process.env.MCPHUB_TOOL_STATS_DIR = join(root, 'index');
});
afterEach(async () => {
  jest.restoreAllMocks();
  process.env = old;
  await rm(root, { recursive: true, force: true });
});

test('warm filtering never opens unchanged raw logs and incremental append ignores duplicate/partial records', async () => {
  const path = join(root, '2026-11-22.jsonl');
  await writeFile(
    path,
    jsonl([call('1'), call('2', { server: 'toolathlon::google_map', status: 'error' })]),
  );
  const scan = jest.spyOn(fs, 'createReadStream');
  expect((await getCallStats(query)).total).toBe(2);
  const reads = scan.mock.calls.length;
  expect((await getCallStats({ ...query, catalog: 'atlas', server: 'GOOGLE' })).total).toBe(1);
  expect((await getCallStats({ ...query, catalog: 'toolathlon' })).errors).toBe(1);
  expect(scan.mock.calls.length).toBe(reads);
  const next = JSON.stringify(call('3', { duration_ms: 50 }));
  await appendFile(path, jsonl([call('1')]) + next.slice(0, -5));
  expect((await getCallStats(query)).total).toBe(2);
  await appendFile(path, next.slice(-5) + '\n');
  const result = await getCallStats(query);
  expect(result.total).toBe(3);
  expect(result.rows.find((r) => r.server === 'atlas::google-maps')?.durationMs).toBe(150);
});

test('late completions, exact local-day boundaries and historical server resolution retain existing semantics', async () => {
  await writeFile(
    join(root, '2026-10-31.jsonl'),
    jsonl([call('start', { event: 'dispatched', server: 'toolathlon::google_map' })]),
  );
  expect((await getCallStats(query)).total).toBe(0);
  await appendFile(
    join(root, '2026-10-31.jsonl'),
    jsonl([call('start', { server: undefined, ts: '2026-10-31T16:00:00.000Z' })]),
  );
  await writeFile(
    join(root, '2026-11-01.jsonl'),
    jsonl([
      call('last', { ts: '2026-11-01T15:59:59.999Z' }),
      call('outside', { ts: '2026-11-01T16:00:00.000Z' }),
    ]),
  );
  const local = {
    start: '2026-10-31T16:00:00.000Z',
    end: '2026-11-01T15:59:59.999Z',
    timeZone: 'Asia/Shanghai',
  };
  const result = await getCallStats(local);
  expect(result.total).toBe(2);
  expect(result.rows.find((r) => r.server === 'toolathlon::google_map')?.calls).toBe(1);
  expect((await getCallStats({ ...local, end: '2026-10-31T16:00:00.000Z' })).total).toBe(1);
});

test('snapshot and cursor survive a process restart and raw log archival without exposing payloads', async () => {
  const path = join(root, '2026-11-22.jsonl');
  await writeFile(
    path,
    jsonl([
      call('1', { arguments: 'PRIVATE-ARGUMENT', result: 'PRIVATE-RESULT', secret: 'PRIVATE-KEY' }),
    ]),
  );
  expect((await getCallStats(query)).total).toBe(1);
  const indexRoot = join(root, 'index', (await readdir(join(root, 'index')))[0]);
  const text = await readFile(join(indexRoot, '2026-11-22.json'), 'utf8');
  expect(text).not.toMatch(/PRIVATE-|arguments|result|secret/);
  jest.resetModules();
  const reloaded = (await import('../../src/services/callStatsService.js')).getCallStats;
  const scan = jest.spyOn(fs, 'createReadStream');
  expect((await reloaded(query)).total).toBe(1);
  expect(scan).not.toHaveBeenCalled();
  await rm(path);
  expect((await reloaded(query)).total).toBe(1);
});

test('truncated and atomically replaced source files rebuild only their own contribution', async () => {
  const path = join(root, '2026-11-22.jsonl');
  await writeFile(path, jsonl([call('1'), call('2')]));
  expect((await getCallStats(query)).total).toBe(2);
  await writeFile(path, jsonl([call('3')]));
  expect((await getCallStats(query)).total).toBe(1);
  await writeFile(path + '.replacement', jsonl([call('4'), call('5'), call('6')]));
  await rename(path + '.replacement', path);
  expect((await getCallStats(query)).total).toBe(3);
});

test('concurrent first queries share raw import and preserve different scopes', async () => {
  await writeFile(
    join(root, '2026-11-22.jsonl'),
    jsonl([call('1'), call('2', { server: 'toolathlon::google_map' })]),
  );
  const scan = jest.spyOn(fs, 'createReadStream');
  const results = await Promise.all([
    getCallStats(query),
    getCallStats({ ...query, catalog: 'atlas' }),
    getCallStats({ ...query, catalog: 'toolathlon' }),
  ]);
  expect(results.map((r) => r.total)).toEqual([2, 1, 1]);
  expect(scan).toHaveBeenCalledTimes(1);
});

test('interruption after snapshot commit rebuilds the summary without replaying completed calls', async () => {
  await writeFile(join(root, '2026-11-22.jsonl'), jsonl([call('1'), call('2')]));
  const originalRename = fsPromises.rename;
  let fail = true;
  jest.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
    if (fail && String(to).endsWith('.summary')) {
      fail = false;
      throw new Error('simulated interruption');
    }
    return originalRename(from, to);
  });
  await expect(getCallStats(query)).rejects.toThrow('simulated interruption');
  const result = await getCallStats(query);
  expect(result.total).toBe(2);
  expect((await getCallStats(query)).total).toBe(2);
});
