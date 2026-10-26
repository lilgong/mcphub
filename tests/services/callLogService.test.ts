import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCallLogs, readAuditTail, CallLogQuery } from '../../src/services/callLogService.js';
import { getCallStats } from '../../src/services/callStatsService.js';
const query: CallLogQuery = {
  date: '2026-10-09',
  status: 'all',
  errorsOnly: true,
  source: 'all',
  server: '',
  page: 1,
  limit: 50,
};
describe('call log reader', () => {
  let root: string;
  const original = { ...process.env };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'call-log-'));
    process.env.MCPHUB_AUDIT_LOG_DIR = root;
    process.env.MCPHUB_KEY_POOL_LOG_DIR = join(root, 'keys');
    process.env.MCP_USAGE_LOG_DIR = join(root, 'yibu');
    process.env.MCPHUB_RELAY_LOG_FILE = join(root, 'relay.jsonl');
  });
  afterEach(async () => {
    process.env = { ...original };
    await rm(root, { recursive: true, force: true });
  });
  const jsonl = (records: object[]) =>
    records.map((value) => JSON.stringify(value)).join('\n') + '\n';
  test('joins tool diagnostics, keeps queue errors, filters real status and omits secrets', async () => {
    await writeFile(
      join(root, `${query.date}.jsonl`),
      jsonl([
        { event: 'dispatched', request_id: 'a', server: 'brave', wait_ms: 100 },
        {
          event: 'completed',
          request_id: 'a',
          server: 'brave',
          status: 'error',
          http_status: 429,
          category: 'rate_limit',
          duration_ms: 10,
          secret: 'private-key',
        },
        {
          event: 'finished',
          request_id: 'a',
          ts: `${query.date}T10:00:00Z`,
          tool: 'search',
          target: 'suite/official',
          taskId: 'isolated-task',
          model: 'legacy-model',
          benchmark: 'legacy-benchmark',
          runId: 'legacy-run',
          status: 'error',
        },
        { event: 'queue_rejected', request_id: 'b', server: 'exa', category: 'queue_timeout' },
        {
          event: 'finished',
          request_id: 'b',
          ts: `${query.date}T11:00:00Z`,
          tool: 'search',
          status: 'error',
        },
        {
          event: 'finished',
          request_id: 'c',
          ts: `${query.date}T12:00:00Z`,
          tool: 'search',
          status: 'success',
        },
      ]),
    );
    const result = await getCallLogs(query);
    expect(result.total).toBe(2);
    expect(result.rows[0]).toMatchObject({ server: 'exa', category: 'queue_timeout' });
    expect(result.rows[1]).toMatchObject({ httpStatus: 429, waitMs: 100 });
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(result.rows[1]).toMatchObject({ target: 'suite/official', taskId: 'isolated-task' });
    for (const field of ['model', 'benchmark', 'runId'])
      expect(result.rows[1]).not.toHaveProperty(field);
    expect((await getCallLogs({ ...query, status: '429' })).total).toBe(1);
    expect((await getCallLogs({ ...query, status: 'none' })).total).toBe(1);
    expect((await getCallLogs({ ...query, errorsOnly: false })).total).toBe(3);
  });
  test('shows relay queue expiry and cancellation without counting successful summaries', async () => {
    await writeFile(
      join(root, 'relay.jsonl'),
      jsonl([
        { event: 'request_queued', parent_request_id: 'expired', host: 'export.arxiv.org' },
        {
          event: 'http_completed',
          request_id: 'expired',
          timestamp: `${query.date}T10:00:00Z`,
          status: 504,
          category: 'queue_timeout',
          upstream_group: 'arxiv',
          queued_ms: 85000,
        },
        {
          event: 'http_completed',
          request_id: 'cancelled',
          timestamp: `${query.date}T10:01:00Z`,
          status: 499,
          category: 'client_cancelled',
          upstream_group: 'arxiv',
        },
        {
          event: 'http_completed',
          request_id: 'ok',
          timestamp: `${query.date}T10:02:00Z`,
          status: 200,
          category: 'success',
          upstream_group: 'arxiv',
        },
      ]),
    );
    const result = await getCallLogs({ ...query, source: 'relay' });
    expect(result.total).toBe(2);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          server: 'arxiv',
          httpStatus: 504,
          category: 'queue_timeout',
          waitMs: 85000,
        }),
        expect.objectContaining({ server: 'arxiv', httpStatus: 499, category: 'client_cancelled' }),
      ]),
    );
    expect((await getCallLogs({ ...query, source: 'relay', status: '504' })).total).toBe(1);
  });
  test('reads relay attempts without double counting workflow summaries and yibu status', async () => {
    await writeFile(
      join(root, 'relay.jsonl'),
      jsonl([
        { event: 'http_started', request_id: 'r', host: 'example.org', path: '/fetch', attempt: 1 },
        {
          event: 'http_finished',
          request_id: 'r',
          timestamp: `${query.date}T10:00:00Z`,
          status: 503,
        },
        { event: 'http_completed', timestamp: `${query.date}T10:00:00Z`, status: 503 },
      ]),
    );
    await mkdir(join(root, 'yibu', '2026-10'), { recursive: true });
    await writeFile(
      join(root, 'yibu', '2026-10', 'brave_20261009.jsonl'),
      jsonl([
        {
          event: 'finished',
          request_id: 'y',
          ts: `${query.date}T11:00:00Z`,
          service: 'brave',
          status: 200,
        },
      ]),
    );
    const result = await getCallLogs(query);
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({
      server: 'example.org',
      operation: '/fetch',
      httpStatus: 503,
    });
    expect((await getCallLogs({ ...query, errorsOnly: false, status: '200' })).rows[0].source).toBe(
      'yibu',
    );
    expect((await getCallLogs({ ...query, status: '5xx', server: 'example' })).total).toBe(1);
  });

  test.each(['upstream_timeout', 'client_cancelled', 'queue_timeout'])(
    'counts HTTP attempts once for %s but retains queue-only failures',
    async (category) => {
      const timestamp = `${query.date}T10:00:00Z`;
      const records = [
        {
          event: 'http_started',
          request_id: 'attempt-1',
          parent_request_id: 'flow',
          host: 'export.arxiv.org',
          path: '/api/query',
          attempt: 1,
        },
        {
          event: 'http_finished',
          request_id: 'attempt-1',
          parent_request_id: 'flow',
          timestamp,
          host: 'export.arxiv.org',
          category: 'rate_limit',
          status: 429,
          attempt: 1,
        },
        {
          event: 'http_started',
          request_id: 'attempt-2',
          parent_request_id: 'flow',
          host: 'export.arxiv.org',
          path: '/api/query',
          attempt: 2,
        },
        {
          event: 'http_finished',
          request_id: 'attempt-2',
          parent_request_id: 'flow',
          timestamp,
          host: 'export.arxiv.org',
          category,
          error_type: 'RelayRequestExpired',
        },
        {
          event: 'http_completed',
          request_id: 'flow',
          timestamp,
          upstream_group: 'arxiv',
          category,
          status: 504,
          attempts: 2,
        },
        {
          event: 'http_completed',
          request_id: 'never-sent',
          timestamp,
          upstream_group: 'arxiv',
          category: 'queue_timeout',
          status: 504,
          attempts: 0,
        },
        {
          event: 'http_finished',
          request_id: 'unrelated',
          parent_request_id: 'other-flow',
          timestamp,
          host: 'export.arxiv.org',
          category: 'success',
          status: 200,
        },
      ];
      // Duplicate records and summary ordering must not change the result.
      await writeFile(join(root, 'relay.jsonl'), jsonl([...records, records[1]]));
      const result = await getCallLogs({ ...query, source: 'relay', errorsOnly: false });
      expect(result.total).toBe(4);
      expect(new Set(result.rows.map((row) => row.id))).toEqual(
        new Set(['attempt-1', 'attempt-2', 'never-sent', 'unrelated']),
      );
      expect(result.rows.find((row) => row.id === 'attempt-2')?.attempts).toBe(2);
      expect(
        (await getCallLogs({ ...query, source: 'relay', status: '504' })).rows.map((row) => row.id),
      ).toEqual(['never-sent']);
      await writeFile(join(root, 'relay.jsonl'), jsonl([...records].reverse()));
      expect((await getCallLogs({ ...query, source: 'relay', errorsOnly: false })).total).toBe(4);
    },
  );
  test('shows key labels and recovery times while omitting secrets and admissions', async () => {
    await mkdir(join(root, 'keys'));
    await writeFile(
      join(root, 'keys', `${query.date}.jsonl`),
      jsonl([
        { event: 'started', request_id: 'k', server: 'context7', key_label: 'test-key' },
        {
          event: 'finished',
          request_id: 'k',
          server: 'context7',
          key_label: 'test-key',
          ts: `${query.date}T10:00:00Z`,
          http_status: 429,
          outcome: 'error',
          category: 'quota_exhausted',
          retry_at: '2026-11-01T00:00:00Z',
          secret: 'do-not-expose',
        },
      ]),
    );
    const result = await getCallLogs({ ...query, source: 'key_pool', status: '429' });
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({
      keyLabel: 'test-key',
      category: 'quota_exhausted',
      retryAt: '2026-11-01T00:00:00Z',
    });
    expect(JSON.stringify(result)).not.toContain('do-not-expose');
  });
  test('bounded tail tolerates partial appends and missing files', async () => {
    const file = join(root, 'partial');
    await writeFile(file, 'x'.repeat(100) + '\n{"ok":true}\n{"partial":');
    expect(await readAuditTail(file, 40)).toEqual({ records: [{ ok: true }], truncated: true });
    expect(await readAuditTail(join(root, 'missing'))).toEqual({ records: [], truncated: false });
  });

  test.each([
    ['2026-10-08', '2026-10-09'],
    ['2026-10-31', '2026-11-01'],
    ['2026-12-31', '2027-01-01'],
  ])('matches statistics for calls completing across %s / %s UTC', async (start, finish) => {
    const server = 'atlas::serper';
    await writeFile(
      join(root, `${start}.jsonl`),
      jsonl([
        { event: 'started', request_id: 'midnight', server, ts: `${start}T23:59:59Z` },
        { event: 'dispatched', request_id: 'midnight', server, wait_ms: 100 },
        {
          event: 'upstream_finished',
          request_id: 'midnight',
          server,
          http_status: 200,
          duration_ms: 20,
        },
        {
          event: 'finished',
          request_id: 'midnight',
          server,
          tool: 'search',
          ts: `${finish}T00:00:01Z`,
          status: 'success',
          duration_ms: 2000,
        },
        {
          event: 'finished',
          request_id: 'old',
          server,
          ts: `${start}T23:59:58Z`,
          status: 'success',
        },
      ]),
    );
    const stats = await getCallStats({
      start: `${finish}T00:00:00Z`,
      end: `${finish}T23:59:59Z`,
      catalog: 'atlas',
    });
    const logs = await getCallLogs({
      ...query,
      date: finish,
      catalog: 'atlas',
      source: 'tool',
      errorsOnly: false,
    });
    expect(stats.total).toBe(1);
    expect(logs.total).toBe(stats.total);
    expect(logs.rows[0]).toMatchObject({
      id: 'midnight',
      timestamp: `${finish}T00:00:01Z`,
      catalog: 'atlas',
      durationMs: 2000,
      waitMs: 100,
      httpStatus: 200,
    });
    expect(
      (
        await getCallLogs({
          ...query,
          date: finish,
          catalog: '',
          source: 'tool',
          errorsOnly: false,
        })
      ).total,
    ).toBe(0);
  });

  test('uses the final outcome and duration while retaining diagnostic details', async () => {
    await writeFile(
      join(root, `${query.date}.jsonl`),
      jsonl([
        { event: 'dispatched', request_id: 'retry', server: 'atlas::serper', wait_ms: 500 },
        {
          event: 'upstream_finished',
          request_id: 'retry',
          server: 'atlas::serper',
          status: 'error',
          http_status: 503,
          category: 'upstream_error',
          duration_ms: 20,
        },
        {
          event: 'finished',
          request_id: 'retry',
          server: 'atlas::serper',
          ts: `${query.date}T10:00:00Z`,
          tool: 'search',
          status: 'error',
          http_status: 504,
          category: 'timeout',
          duration_ms: 2000,
        },
      ]),
    );
    const logs = await getCallLogs({ ...query, source: 'tool' });
    expect(logs.rows[0]).toMatchObject({
      durationMs: 2000,
      waitMs: 500,
      httpStatus: 504,
      category: 'timeout',
      outcome: 'error',
    });
    expect(
      (await getCallStats({ start: `${query.date}T00:00:00Z`, end: `${query.date}T23:59:59Z` }))
        .rows[0].durationMs,
    ).toBe(2000);
  });

  test('distinguishes an unavailable Relay log from an existing empty file', async () => {
    const missing = await getCallLogs({ ...query, source: 'relay' });
    expect(missing.total).toBe(0);
    expect(missing.unavailableSources).toEqual(['relay']);
    await writeFile(join(root, 'relay.jsonl'), '');
    expect((await getCallLogs({ ...query, source: 'relay' })).unavailableSources).toEqual([]);
    delete process.env.MCPHUB_RELAY_LOG_FILE;
    expect((await getCallLogs({ ...query, source: 'relay' })).unavailableSources).toEqual([
      'relay',
    ]);
  });

  test('does not attribute unknown Relay records to public or guess a benchmark namespace', async () => {
    await writeFile(
      join(root, 'relay.jsonl'),
      jsonl([
        {
          event: 'http_finished',
          request_id: 'unknown',
          timestamp: `${query.date}T10:00:00Z`,
          upstream_group: 'arxiv',
          status: 503,
        },
        {
          event: 'http_finished',
          request_id: 'scoped',
          timestamp: `${query.date}T10:01:00Z`,
          upstream_group: 'arxiv',
          catalog: 'atlas',
          status: 503,
        },
        {
          event: 'http_finished',
          request_id: 'public',
          timestamp: `${query.date}T10:02:00Z`,
          upstream_group: 'arxiv',
          catalog: '',
          status: 503,
        },
      ]),
    );
    for (const [catalog, id] of [
      ['_unassigned', 'unknown'],
      ['atlas', 'scoped'],
      ['', 'public'],
    ]) {
      const result = await getCallLogs({ ...query, source: 'relay', catalog });
      expect(result.total).toBe(1);
      expect(result.rows[0]).toMatchObject({ id, catalog });
    }
  });
});
