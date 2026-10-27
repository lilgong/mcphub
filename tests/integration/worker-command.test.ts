import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntimeWorker } from '../../src/workers/runtimeWorker.js';
import { WorkerStdioTransport } from '../../src/clients/workerStdioTransport.js';
import { LegacyMcpClient } from '../../src/clients/legacyMcpClient.js';
(process.platform === 'linux' ? test : test.skip)(
  'starts an executable bundled in command with empty args',
  async () => {
    const previous = process.env;
    const root = await mkdtemp(join(tmpdir(), 'worker-command-rpc-'));
    process.env = {
      ...previous,
      MCPHUB_WORKER_PACKAGES: join(root, 'uploads'),
      MCPHUB_WORKER_RELEASES: join(root, 'releases'),
    };
    const worker = createRuntimeWorker('atlas', 'test-control-token'.repeat(3));
    const client = new LegacyMcpClient({ name: 'command-test', version: '1' });
    try {
      const source = join(root, 'uploads/server-atlas~shell');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: '1' }));
      const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
      await writeFile(
        join(source, 'server.sh'),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('tests/fixtures/catalog-server.mjs'))}\n`,
        { mode: 0o755 },
      );
      await new Promise<void>((done) => worker.server.listen(0, '127.0.0.1', done));
      const port = (worker.server.address() as { port: number }).port;
      await client.connect(
        new WorkerStdioTransport(
          {
            id: 'atlas',
            catalog: 'atlas',
            url: `ws://127.0.0.1:${port}/stdio`,
            token: 'test-control-token'.repeat(3),
          },
          {
            name: 'atlas::shell',
            command: '/app/data/uploads/mcpb/catalogs/atlas/server-atlas~shell/server.sh',
            args: [],
            env: { PERSONAL_KEY: 'command-migrated' },
            maxBufferSize: 10485760,
          },
        ),
      );
      const result = await client.callTool({ name: 'identity', arguments: {} });
      expect(JSON.parse((result.content as { text: string }[])[0].text).credential).toBe(
        'command-migrated',
      );
    } finally {
      await client.close();
      await worker.close();
      process.env = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
