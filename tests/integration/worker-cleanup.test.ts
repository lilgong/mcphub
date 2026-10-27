import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntimeWorker } from '../../src/workers/runtimeWorker.js';
import { WorkerStdioTransport } from '../../src/clients/workerStdioTransport.js';
import { LegacyMcpClient } from '../../src/clients/legacyMcpClient.js';
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function live(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch {
    return false;
  }
}
async function waitFor(check: () => Promise<boolean>, budget = 5000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('Worker process cleanup did not finish');
}
(process.platform === 'linux' ? describe : describe.skip)('worker descendant cleanup', () => {
  test.each(['disconnect', 'leader exit', 'detached descendants', 'worker shutdown'])(
    '%s kills TERM-resistant descendants without affecting another MCP',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'worker-cleanup-'));
      const worker = createRuntimeWorker('atlas', 'test-worker-token'.repeat(3));
      await new Promise<void>((done) => worker.server.listen(0, '127.0.0.1', done));
      const port = (worker.server.address() as { port: number }).port;
      const endpoint = {
        id: 'test',
        catalog: 'atlas',
        url: `ws://127.0.0.1:${port}/stdio`,
        token: 'test-worker-token'.repeat(3),
      };
      const target = new LegacyMcpClient({ name: 'target', version: '1' });
      const survivor = new LegacyMcpClient({ name: 'survivor', version: '1' });
      const pids: number[] = [];
      try {
        await target.connect(
          new WorkerStdioTransport(endpoint, {
            name: 'atlas::target',
            command: process.execPath,
            args: [resolve('tests/fixtures/worker-descendant-server.mjs'), 'root', directory],
            env: { WORKER_TEST_DETACH: String(mode === 'detached descendants') },
            maxBufferSize: 10485760,
          }),
        );
        await survivor.connect(
          new WorkerStdioTransport(endpoint, {
            name: 'atlas::survivor',
            command: process.execPath,
            args: [resolve('tests/fixtures/catalog-server.mjs')],
            env: { PERSONAL_KEY: 'survivor' },
            maxBufferSize: 10485760,
          }),
        );
        await waitFor(async () => {
          try {
            await readFile(join(directory, 'grandchild.pid'));
            return true;
          } catch {
            return false;
          }
        });
        for (const name of ['root', 'child', 'grandchild'])
          pids.push(Number(await readFile(join(directory, name + '.pid'), 'utf8')));
        const rootStat = await readFile(`/proc/${pids[0]}/stat`, 'utf8');
        const fields = rootStat.slice(rootStat.lastIndexOf(')') + 2).split(' ');
        expect(Number(fields[2])).toBe(pids[0]); // Own process group.
        expect(Number(fields[3])).toBe(pids[0]); // Own session.
        if (mode === 'disconnect' || mode === 'detached descendants') await target.close();
        else if (mode === 'leader exit') await target.callTool({ name: 'exit', arguments: {} });
        else await worker.close();
        await waitFor(async () => (await Promise.all(pids.map(live))).every((alive) => !alive));
        if (mode !== 'worker shutdown') {
          const result = await survivor.callTool({ name: 'identity', arguments: {} });
          expect(JSON.parse((result.content as { text: string }[])[0].text).credential).toBe(
            'survivor',
          );
        }
      } finally {
        // A regression must not leave the deliberately stubborn test children behind.
        for (const pid of pids) {
          try {
            const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8');
            if (cmd.includes('worker-descendant-server.mjs')) process.kill(pid, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }
        await Promise.allSettled([target.close(), survivor.close()]);
        await worker.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    15000,
  );
});
