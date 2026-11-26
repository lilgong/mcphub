import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestContextService } from '../../src/services/requestContextService.js';
import {
  captureToolDiagnostic,
  withToolAudit,
  describeToolFailure,
  describeToolAuditFailure,
} from '../../src/services/toolAuditService.js';
import { getCallLogs } from '../../src/services/callLogService.js';
import { getCallStats } from '../../src/services/callStatsService.js';

const mockActivity = jest.fn(async () => undefined);
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: () => ({ logToolCall: mockActivity }),
}));
jest.mock('../../src/utils/logger.js', () => ({ logger: { log: jest.fn() } }));

describe('durable tool audit', () => {
  let directory: string;
  const previous = process.env.MCPHUB_AUDIT_LOG_DIR;
  beforeEach(() => {
    mockActivity.mockClear();
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

  it('persists opted-in direct calls once, retains their space, and leaves MCP activity to its existing logger', async () => {
    await withToolAudit(
      { server: 'atlas::exa', tool: 'search' },
      async () => ({ isError: false }),
      true,
    );
    expect(mockActivity).toHaveBeenCalledTimes(1);
    expect(mockActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ server: 'atlas::exa', status: 'success' }),
    );
    await withToolAudit(
      { server: 'toolathlon::exa', tool: 'search' },
      async () => ({ isError: true }),
      true,
    );
    expect(mockActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ server: 'toolathlon::exa', status: 'error' }),
    );
    await expect(
      withToolAudit(
        { server: 'atlas::exa', tool: 'search' },
        async () => {
          throw new Error('private');
        },
        true,
      ),
    ).rejects.toThrow('private');
    expect(mockActivity).toHaveBeenCalledTimes(3);
    expect(mockActivity).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }));
    expect(JSON.stringify(mockActivity.mock.calls)).not.toContain('private');
    await withToolAudit({ server: 'atlas::exa', tool: 'search' }, async () => ({ isError: false }));
    expect(mockActivity).toHaveBeenCalledTimes(3);
  });

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

  it('records tool error text without copying unrelated response fields', async () => {
    await withToolAudit({ tool: 'search' }, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'Permission denied' }],
      privateBody: 'secret',
    }));
    const events = records(directory);
    expect(events[1].status).toBe('error');
    expect(events[1].error_message).toBe('Permission denied');
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('records thrown error diagnostics without storing credentials', async () => {
    await expect(
      withToolAudit({ tool: 'search' }, async () => {
        throw new Error('Connection failed secret=private-value');
      }),
    ).rejects.toThrow('Connection failed');
    expect(records(directory)[1].status).toBe('error');
    expect(records(directory)[1].error_message).toContain('Connection failed');
    expect(JSON.stringify(records(directory))).not.toContain('private-value');
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

  it('exposes error text and recognizes provider status formats without changing scheduler classification', async () => {
    const result = {
      isError: true,
      content: [
        { type: 'text', text: 'web_search_exa error (403): quota exhausted api_key=do-not-save' },
      ],
    };
    expect(describeToolFailure(result)).not.toHaveProperty('http_status');
    await withToolAudit({ server: 'atlas::exa', tool: 'search' }, async () => result);
    const logs = await getCallLogs({
      date: new Date().toISOString().slice(0, 10),
      status: '403',
      errorsOnly: true,
      source: 'tool',
      server: '',
      page: 1,
      limit: 10,
    });
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({ httpStatus: 403, outcome: 'error' });
    expect(logs.rows[0].errorMessage).toContain('quota exhausted');
    expect(JSON.stringify(logs)).not.toContain('do-not-save');
    expect(JSON.stringify(records(directory))).not.toContain('do-not-save');
  });

  it('retains protocol error details without inventing an HTTP status', async () => {
    await withToolAudit({ tool: 'translate' }, async () => ({
      isError: true,
      content: [{ type: 'text', text: 'ProtocolError | An unknown error occurred | code=-32603' }],
    }));
    const event = records(directory).at(-1);
    expect(event.error_message).toContain('ProtocolError');
    expect(event).not.toHaveProperty('http_status');
  });

  it('keeps routing identifiers but ignores retired reporting headers', async () => {
    await RequestContextService.getInstance().runWithCustomRequestContext(
      {
        headers: {
          'x-mcphub-target': 'suite/official',
          'x-mcphub-task-id': 'isolated-task',
          'x-mcphub-model': 'legacy-model',
          'x-mcphub-benchmark': 'legacy-benchmark',
          'x-mcphub-run-id': 'legacy-run',
        },
      },
      () => withToolAudit({ tool: 'search' }, async () => ({ isError: false })),
    );
    for (const event of records(directory)) {
      expect(event).toMatchObject({ target: 'suite/official', taskId: 'isolated-task' });
      for (const field of ['model', 'benchmark', 'runId']) expect(event).not.toHaveProperty(field);
    }
  });

  it('preserves existing behavior when the optional audit is disabled', async () => {
    delete process.env.MCPHUB_AUDIT_LOG_DIR;
    await expect(
      withToolAudit({ tool: 'search' }, async () => ({ isError: false })),
    ).resolves.toEqual({ isError: false });
    expect(readdirSync(directory)).toEqual([]);
  });

  it('records PubMed content errors as HTTP 500 in web filters and statistics without changing results or retry classification', async () => {
    const result = {
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error:
              'An error occurred while searching: NCBI returned HTTP 500 after relay retries private-query-key',
          }),
        },
      ],
    };
    const before = JSON.stringify(result);
    const returned = await withToolAudit(
      { server: 'atlas::pubmed', tool: 'pubmed_search_pubmed_key_words' },
      async () => {
        await captureToolDiagnostic('atlas::pubmed')('completed', { status: 'success' });
        return result;
      },
      true,
    );
    expect(returned).toBe(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(describeToolFailure(result)).toBeUndefined();
    expect(records(directory).at(-1)).toMatchObject({
      status: 'error',
      http_status: 500,
      category: 'upstream_error',
    });
    expect(mockActivity).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    expect(records(directory).at(-1).error_message).toContain('NCBI returned HTTP 500');
    const date = new Date().toISOString().slice(0, 10);
    const logs = await getCallLogs({
      date,
      status: '500',
      source: 'tool',
      errorsOnly: true,
      server: 'atlas::pubmed',
      page: 1,
      limit: 20,
    });
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({ httpStatus: 500, outcome: 'error' });
    const stats = await getCallStats({ start: date + 'T00:00:00Z', end: date + 'T23:59:59.999Z' });
    expect(stats).toMatchObject({ total: 1, errors: 1, success: 0 });
  });

  it.each([
    {
      content: [{ type: 'text', text: '[{"error":"NCBI returned HTTP 500 after relay retries"}]' }],
    },
    { structuredContent: { error: 'NCBI returned HTTP 500 after relay retries' } },
    { structuredContent: { result: [{ error: 'NCBI returned HTTP 500 after relay retries' }] } },
    {
      content: [
        {
          type: 'text',
          text: 'An error occurred while attempting to download the PDF: NCBI returned HTTP 500 after relay retries',
        },
      ],
    },
  ])(
    'recognizes PubMed error envelopes without requiring the protocol error flag: %p',
    (result) => {
      expect(describeToolAuditFailure(result, 'download_pubmed_pdf')).toMatchObject({
        http_status: 500,
        category: 'upstream_error',
      });
    },
  );

  it('keeps rate-limit reporting separate from scheduler decisions', () => {
    const result = {
      isError: false,
      content: [{ type: 'text', text: '{"error":"NCBI returned HTTP 429 after relay retries"}' }],
    };
    expect(describeToolAuditFailure(result, 'search_pubmed_advanced')).toMatchObject({
      http_status: 429,
      category: 'rate_limit',
    });
    expect(describeToolFailure(result)).toBeUndefined();
  });

  it.each([
    {
      content: [
        {
          type: 'text',
          text: '{"PMID":"123","Abstract":"NCBI returned HTTP 500 after relay retries"}',
        },
      ],
    },
    { content: [{ type: 'text', text: 'A paper discussing errors and HTTP 500.' }] },
    { content: [{ type: 'text', text: '[]' }] },
    { content: [{ type: 'text', text: '{"error":null}' }] },
    { content: [{ type: 'text', text: '{invalid json' }] },
    { content: [{ type: 'text', text: 'No downloadable PDF found for PMID: 123' }] },
  ])(
    'does not mistake successful PubMed data, empty results or ordinary text for errors: %p',
    (result) => {
      expect(describeToolAuditFailure(result, 'pubmed_search_pubmed_key_words')).toBeUndefined();
    },
  );

  it('does not interpret arbitrary tools or oversized text as PubMed error payloads', () => {
    const text = '{"error":"NCBI returned HTTP 500 after relay retries"}';
    expect(
      describeToolAuditFailure({ content: [{ type: 'text', text }] }, 'fetch_json'),
    ).toBeUndefined();
    expect(
      describeToolAuditFailure(
        { content: [{ type: 'text', text: text + ' '.repeat(65536) }] },
        'pubmed_search_pubmed_key_words',
      ),
    ).toBeUndefined();
  });
});
