import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCallStats } from '../../src/services/callStatsService.js';
import { getUpstreamStats } from '../../src/services/upstreamStatsService.js';
import { getCallLogs } from '../../src/services/callLogService.js';
import { scopedUsageDirectory } from '../../src/services/usageLogDirectories.js';

it('separates same-name MCPs by space, preserves five provider attempt counts, and keeps legacy usage unassigned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-counts-'));
  const saved = { ...process.env };
  process.env.MCPHUB_AUDIT_LOG_DIR = join(root, 'audit');
  process.env.MCP_USAGE_LOG_DIR = join(root, 'usage');
  process.env.MCPHUB_KEY_POOL_LOG_DIR = join(root, 'pool');
  const date = '2026-10-26';
  const ts = date + 'T01:00:00.000Z';
  const providers = ['exa', 'oxylabs', 'brave-search', 'weather-data', 'lara-translate'];
  const jsonl = (records: object[]) => records.map((row) => JSON.stringify(row)).join('\n') + '\n';
  try {
    const audit: object[] = [];
    for (const catalog of ['atlas', 'toolathlon']) {
      for (const service of providers) {
        const server = `${catalog}::${service}`;
        audit.push({
          event: 'finished',
          server,
          ts,
          request_id: `${server}-tool`,
          status: 'success',
        });
        const directory = join(
          scopedUsageDirectory(process.env.MCP_USAGE_LOG_DIR!, server),
          '2026-10',
        );
        await mkdir(directory, { recursive: true });
        const record = {
          event: 'finished',
          service,
          ts,
          request_id: 'same-id-across-spaces',
          status: 200,
        };
        // One tool call, two HTTP attempts, duplicated record must count once.
        await writeFile(
          join(directory, service + '_20261026.jsonl'),
          jsonl([record, record, { ...record, request_id: 'retry', status: 429 }]),
        );
      }
    }
    await mkdir(process.env.MCPHUB_AUDIT_LOG_DIR!, { recursive: true });
    await writeFile(join(process.env.MCPHUB_AUDIT_LOG_DIR!, date + '.jsonl'), jsonl(audit));
    const legacy = join(process.env.MCP_USAGE_LOG_DIR!, '2026-10');
    await mkdir(legacy, { recursive: true });
    await writeFile(
      join(legacy, 'exa_20261026.jsonl'),
      jsonl([{ event: 'finished', service: 'exa', ts, request_id: 'old', status: 200 }]),
    );
    const range = { start: date + 'T00:00:00.000Z', end: date + 'T23:59:59.999Z' };
    expect((await getCallStats(range)).total).toBe(10);
    expect((await getCallStats({ ...range, catalog: 'atlas' })).total).toBe(5);
    expect((await getCallStats({ ...range, catalog: '', server: 'exa' })).total).toBe(0);
    const upstream = await getUpstreamStats({ ...range, catalog: 'atlas' });
    expect(upstream.total).toBe(10);
    expect(upstream.errors).toBe(5);
    expect(upstream.rows).toHaveLength(5);
    expect((await getUpstreamStats({ ...range, catalog: 'toolathlon', server: 'exa' })).total).toBe(
      2,
    );
    expect((await getUpstreamStats({ ...range, catalog: '_legacy' })).total).toBe(1);
    const logs = await getCallLogs({
      date,
      catalog: 'atlas',
      source: 'yibu',
      errorsOnly: false,
      status: 'all',
      server: '',
      page: 1,
      limit: 100,
    });
    // Detail and aggregate views both deduplicate repeated records, retaining each attempt.
    expect(logs.rows.every((row) => row.server.startsWith('atlas::'))).toBe(true);
    expect(logs.total).toBe(10);
  } finally {
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  }
});
