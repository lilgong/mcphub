import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCallLogs, readAuditTail, CallLogQuery } from '../../src/services/callLogService.js';
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
    expect((await getCallLogs({ ...query, status: '429' })).total).toBe(1);
    expect((await getCallLogs({ ...query, status: 'none' })).total).toBe(1);
    expect((await getCallLogs({ ...query, errorsOnly: false })).total).toBe(3);
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
});
