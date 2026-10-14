import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getUpstreamStats } from '../../src/services/upstreamStatsService';
it('combines complete HTTP, MCP and key-pool attempts; matches roles and deduplicates one request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upstream-stats-'));
  const old = {
    audit: process.env.MCPHUB_AUDIT_LOG_DIR,
    usage: process.env.MCP_USAGE_LOG_DIR,
    pool: process.env.MCPHUB_KEY_POOL_LOG_DIR,
  };
  process.env.MCPHUB_AUDIT_LOG_DIR = root;
  process.env.MCP_USAGE_LOG_DIR = join(root, 'usage');
  process.env.MCPHUB_KEY_POOL_LOG_DIR = join(root, 'pool');
  const ts = '2026-10-14T05:00:00Z',
    id = '0123456789abcdef';
  const jsonl = (records: object[]) => records.map((v) => JSON.stringify(v)).join('\n') + '\n';
  try {
    const http = {
      event: 'upstream_finished',
      request_id: 'tool',
      upstream_request_id: 'http-1',
      server: 'serper-a',
      ts,
      http_status: 200,
      status: 'success',
      upstream_credentials: JSON.stringify([
        { role: 'authorization', id },
        { role: 'x-api-key', id },
      ]),
    };
    await writeFile(
      join(root, '2026-10-14.jsonl'),
      jsonl([
        http,
        http,
        { ...http, event: 'finished' },
        {
          ...http,
          upstream_request_id: 'http-2',
          server: 'serper-b',
          upstream_credentials: JSON.stringify([{ id: 'different' }]),
        },
      ]),
    );
    await mkdir(join(root, 'usage', '2026-10'), { recursive: true });
    const mcp = {
      event: 'finished',
      service: 'brave',
      request_id: 'mcp-1',
      ts,
      credential_id: id,
      status: 429,
    };
    await writeFile(
      join(root, 'usage', '2026-10', 'brave_test_20261014.jsonl'),
      jsonl([mcp, { ...mcp, event: 'started' }, mcp]),
    );
    await mkdir(join(root, 'pool'));
    await writeFile(
      join(root, 'pool', '2026-10-14.jsonl'),
      jsonl([
        {
          event: 'finished',
          server: 'context7',
          request_id: 'pool-1',
          ts,
          credential_id: id,
          http_status: 200,
        },
        { event: 'pool_unavailable', ts, server: 'context7' },
      ]),
    );
    const query = { start: '2026-10-14T00:00:00Z', end: '2026-10-14T23:59:59Z', credentialId: id };
    const result = await getUpstreamStats(query);
    expect(result.total).toBe(3);
    expect(result.errors).toBe(1);
    expect(result.partialCoverage).toBe(true);
    expect(result.rows.map((r) => r.server).sort()).toEqual([
      'brave-search',
      'context7',
      'serper-a',
    ]);
    expect((await getUpstreamStats({ ...query, server: 'serper-a' })).total).toBe(1);
    expect((await getUpstreamStats({ ...query, credentialId: 'unmatched' })).total).toBe(0);
    expect((await getUpstreamStats({ ...query, credentialId: undefined })).total).toBe(4);
  } finally {
    for (const [name, value] of [
      ['MCPHUB_AUDIT_LOG_DIR', old.audit],
      ['MCP_USAGE_LOG_DIR', old.usage],
      ['MCPHUB_KEY_POOL_LOG_DIR', old.pool],
    ]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
