import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCallStats } from '../../src/services/callStatsService.js';
test('counts complete audit history once, ignores attempts, includes midnight completion and aggregates legacy labels across targets and filters by MCP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-stats-'));
  const previous = process.env.MCPHUB_AUDIT_LOG_DIR;
  process.env.MCPHUB_AUDIT_LOG_DIR = root;
  try {
    const jsonl = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    const finished = {
      event: 'finished',
      request_id: '1',
      server: 'filesystem',
      target: 'project/official',
      model: 'model-a',
      benchmark: 'bench-x',
      ts: '2026-10-09T00:00:01.000Z',
      status: 'success',
    };
    await writeFile(
      join(root, '2026-10-08.jsonl'),
      jsonl([{ ...finished, event: 'started' }, finished]),
    );
    const many = Array.from({ length: 12000 }, (_, n) => ({
      event: 'finished',
      request_id: String(n + 2),
      server: 'context7',
      ts: '2026-10-09T10:00:00.000Z',
      status: n % 2 ? 'error' : 'success',
    }));
    await writeFile(
      join(root, '2026-10-09.jsonl'),
      jsonl([
        { event: 'attempt_finished', request_id: 'attempt', ts: finished.ts },
        ...many,
        {
          ...finished,
          request_id: 'second-target',
          target: 'project/synthetic',
          model: 'model-b',
          ts: '2026-10-09T10:00:00.000Z',
        },
        many[0],
      ]),
    );
    const query = { start: '2026-10-09T00:00:00.000Z', end: '2026-10-09T23:59:59.999Z' };
    const result = await getCallStats(query);
    expect(result.total).toBe(12002);
    expect(result.rows.filter((row) => row.server === 'filesystem')).toHaveLength(1);
    expect(result.rows.find((row) => row.server === 'filesystem')?.calls).toBe(2);
    expect(result.errors).toBe(6000);
    const filesystem = await getCallStats({ ...query, server: 'filesystem' });
    expect(filesystem.total).toBe(2);
    expect(filesystem.rows).toHaveLength(1);
    expect(filesystem.rows[0]).not.toHaveProperty('model');
    expect(filesystem.rows[0]).not.toHaveProperty('benchmark');
    expect(filesystem.rows[0]).not.toHaveProperty('target');
    expect((await getCallStats({ ...query, end: '2026-10-09T01:00:00.000Z' })).total).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.MCPHUB_AUDIT_LOG_DIR;
    else process.env.MCPHUB_AUDIT_LOG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
