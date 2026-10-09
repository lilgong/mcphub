import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureToolDiagnostic, withToolAudit } from '../../src/services/toolAuditService.js';

jest.mock('../../src/utils/logger.js', () => ({ logger: { log: jest.fn() } }));

describe('durable tool audit', () => {
  let directory: string;
  const previous = process.env.MCPHUB_AUDIT_LOG_DIR;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hub-tool-audit-'));
    process.env.MCPHUB_AUDIT_LOG_DIR = directory;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.MCPHUB_AUDIT_LOG_DIR;
    else process.env.MCPHUB_AUDIT_LOG_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const records = (directory: string) =>
    readFileSync(join(directory, readdirSync(directory)[0]), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

  it('persists start before invoking a tool and records one completion', async () => {
    await withToolAudit({ tool: 'brave-search-brave_web_search' }, async () => {
      expect(records(directory).map((record) => record.event)).toEqual(['started']);
      return { isError: false };
    });
    const events = records(directory);
    expect(events.map((record) => record.event)).toEqual(['started', 'finished']);
    expect(events[0].request_id).toBe(events[1].request_id);
    expect(events[1].status).toBe('success');
  });

  it('blocks a tool invocation when the audit file cannot be written', async () => {
    const blocked = join(directory, 'blocked');
    writeFileSync(blocked, 'file');
    process.env.MCPHUB_AUDIT_LOG_DIR = blocked;
    const call = jest.fn();
    await expect(withToolAudit({ tool: 'search' }, call)).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it('records tool errors without storing response bodies', async () => {
    await withToolAudit({ tool: 'search' }, async () => ({ isError: true, content: 'secret' }));
    const events = records(directory);
    expect(events[1].status).toBe('error');
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('records thrown errors without storing error text', async () => {
    await expect(
      withToolAudit({ tool: 'search' }, async () => {
        throw new Error('secret');
      }),
    ).rejects.toThrow('secret');
    expect(records(directory)[1].status).toBe('error');
    expect(JSON.stringify(records(directory))).not.toContain('secret');
  });

  it('correlates scheduling and safe error details with the admission record', async () => {
    await withToolAudit({ tool: 'api-search' }, async () => {
      captureToolDiagnostic('api')('dispatched', { wait_ms: 12 });
      return { isError: true, content: [{ text: 'HTTP 429 secret=never-log' }] };
    });
    const events = records(directory);
    expect(new Set(events.map((record) => record.request_id)).size).toBe(1);
    expect(events[1]).toMatchObject({ server: 'api', event: 'dispatched', wait_ms: 12 });
    expect(events[2]).toMatchObject({ status: 'error', category: 'rate_limit', http_status: 429 });
    expect(JSON.stringify(events)).not.toContain('never-log');
  });

  it('preserves existing behavior when the optional audit is disabled', async () => {
    delete process.env.MCPHUB_AUDIT_LOG_DIR;
    await expect(
      withToolAudit({ tool: 'search' }, async () => ({ isError: false })),
    ).resolves.toEqual({ isError: false });
    expect(readdirSync(directory)).toEqual([]);
  });
});
