import { mkdtemp, writeFile, appendFile, rm, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCallLogRecords } from '../../src/services/callLogIndexService.js';

describe('complete incremental call log index', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'call-index-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const row = (id: string) =>
    JSON.stringify({
      event: 'finished',
      request_id: id,
      ts: '2026-11-25T10:00:00Z',
      server: 'toolathlon::google_map',
      secret: 'never-retain',
    }) + '\n';

  test('retains early records beyond the former tail and on repeated appends', async () => {
    const file = join(root, 'audit.jsonl');
    await writeFile(
      file,
      row('early') +
        (JSON.stringify({ event: 'started', padding: 'x'.repeat(1024) }) + '\n').repeat(4500) +
        row('late'),
    );
    const original = await readFile(file);
    expect((await readCallLogRecords(file)).map((r) => r.request_id)).toEqual(['early', 'late']);
    await appendFile(file, row('new'));
    const [a, b] = await Promise.all([readCallLogRecords(file), readCallLogRecords(file)]);
    expect(a.map((r) => r.request_id)).toEqual(['early', 'late', 'new']);
    expect(b).toEqual(a);
    expect(JSON.stringify(a)).not.toContain('never-retain');
    expect((await readFile(file)).subarray(0, original.length)).toEqual(original);
  });

  test('resumes partial UTF-8 lines without dropping or duplicating records', async () => {
    const file = join(root, 'partial.jsonl');
    const bytes = Buffer.from(JSON.stringify({ event: 'finished', request_id: '中文' }) + '\n');
    const cut = bytes.indexOf(Buffer.from('中文')) + 1;
    await writeFile(file, Buffer.concat([Buffer.from(row('first')), bytes.subarray(0, cut)]));
    expect((await readCallLogRecords(file)).map((r) => r.request_id)).toEqual(['first']);
    await appendFile(file, bytes.subarray(cut));
    expect((await readCallLogRecords(file)).map((r) => r.request_id)).toEqual(['first', '中文']);
    expect((await readCallLogRecords(file)).map((r) => r.request_id)).toEqual(['first', '中文']);
  });

  test('keeps error flags when no human-readable error message is available', async () => {
    const file = join(root, 'error.jsonl');
    await writeFile(
      file,
      JSON.stringify({ event: 'finished', request_id: 'error', error: true }) + '\n',
    );
    expect(await readCallLogRecords(file)).toMatchObject([{ error: true }]);
  });

  test('rebuilds truncated and replaced files, handles deleted sources explicitly', async () => {
    const file = join(root, 'rotated.jsonl');
    await writeFile(file, row('a') + row('b'));
    await readCallLogRecords(file);
    await writeFile(file, row('c'));
    expect((await readCallLogRecords(file)).map((r) => r.request_id)).toEqual(['c']);
    await writeFile(join(root, 'new'), row('d') + row('e'));
    await rename(join(root, 'new'), file);
    expect((await readCallLogRecords(file)).map((r) => r.request_id)).toEqual(['d', 'e']);
    await rm(file);
    expect(await readCallLogRecords(file)).toEqual([]);
    await expect(readCallLogRecords(file, { allowMissing: false })).rejects.toThrow();
  });
});
