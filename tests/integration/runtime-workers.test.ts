import { createRuntimeWorker } from '../../src/workers/runtimeWorker.js';
import { WorkerStdioTransport } from '../../src/clients/workerStdioTransport.js';
import { LegacyMcpClient } from '../../src/clients/legacyMcpClient.js';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import type { RuntimeWorker } from '../../src/services/runtimeWorkerService.js';

(process.platform === 'linux' ? describe : describe.skip)(
  'authenticated raw MCP execution worker',
  () => {
    const token = 'worker-control-secret-that-is-not-a-provider-key';
    let worker: ReturnType<typeof createRuntimeWorker>;
    let endpoint: RuntimeWorker;
    const transports: WorkerStdioTransport[] = [];
    beforeAll(async () => {
      worker = createRuntimeWorker('atlas', token);
      await new Promise<void>((done) => worker.server.listen(0, '127.0.0.1', done));
      const port = (worker.server.address() as { port: number }).port;
      endpoint = {
        id: 'atlas-worker',
        catalog: 'atlas',
        token,
        url: `ws://127.0.0.1:${port}/stdio`,
      };
    });
    afterAll(async () => {
      await Promise.all(transports.map((transport) => transport.close()));
      await worker.close();
    });
    const connect = async (credential: string) => {
      const transport = new WorkerStdioTransport(endpoint, {
        name: 'atlas::notion',
        command: process.execPath,
        args: [resolve('tests/fixtures/catalog-server.mjs')],
        env: { PERSONAL_KEY: credential },
        maxBufferSize: 10 * 1024 * 1024,
      });
      transports.push(transport);
      const client = new LegacyMcpClient({ name: 'worker-test', version: '1' });
      await client.connect(transport);
      return { client, transport };
    };
    test('preserves discovery schemas, version, prompts, resources and tool output', async () => {
      const remote = await connect('same-provider-key');
      const local = new LegacyMcpClient({ name: 'local-test', version: '1' });
      await local.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve('tests/fixtures/catalog-server.mjs')],
          env: { PERSONAL_KEY: 'same-provider-key' },
        }),
      );
      try {
        expect((await remote.client.listTools()).tools).toEqual((await local.listTools()).tools);
        expect(remote.client.getServerVersion()).toEqual(local.getServerVersion());
        expect((await remote.client.listResources()).resources).toEqual(
          (await local.listResources()).resources,
        );
        expect((await remote.client.listPrompts()).prompts).toEqual(
          (await local.listPrompts()).prompts,
        );
        const result = await remote.client.callTool({ name: 'identity', arguments: {} });
        expect(JSON.parse((result.content as { text: string }[])[0].text).credential).toBe(
          'same-provider-key',
        );
        expect(remote.transport).toBeInstanceOf(StdioClientTransport);
        expect(remote.transport.pid).toBeNull();
      } finally {
        await local.close();
        await remote.client.close();
      }
    });
    test('separate upstream connections keep account values separate and take new keys on reconnect', async () => {
      const a = await connect('key-a'),
        b = await connect('key-b');
      const results = await Promise.all(
        [a, b].map(({ client }) => client.callTool({ name: 'identity', arguments: {} })),
      );
      const values = results.map((r) => JSON.parse((r.content as { text: string }[])[0].text));
      expect(values.map((v) => v.credential)).toEqual(['key-a', 'key-b']);
      expect(values[0].pid).not.toBe(values[1].pid);
      await Promise.all([a.client.close(), b.client.close()]);
    });
    test('requires a control token and rejects a different namespace before spawning', async () => {
      for (const changed of [{ ...endpoint, token: 'bad-token' }, endpoint]) {
        const transport = new WorkerStdioTransport(changed, {
          name: 'toolathlon::fetch',
          command: process.execPath,
          args: [],
          env: {},
          maxBufferSize: 1024,
        });
        transports.push(transport);
        await expect(transport.start()).rejects.toThrow();
        await transport.close();
      }
      const health = endpoint.url.replace('ws:', 'http:').replace('/stdio', '/health');
      expect((await fetch(health)).status).toBe(401);
      const response = await fetch(health, { headers: { Authorization: `Bearer ${token}` } });
      expect(await response.json()).toMatchObject({ catalog: 'atlas' });
    });
    test('cancellation crosses the bridge and does not break the next call', async () => {
      const { client } = await connect('cancel-test');
      try {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 30);
        await expect(
          client.callTool(
            { name: 'identity', arguments: { delay: 500 } },
            { signal: abort.signal },
          ),
        ).rejects.toThrow();
        clearTimeout(timer);
        const result = await client.callTool({ name: 'identity', arguments: {} });
        expect(JSON.parse((result.content as { text: string }[])[0].text).credential).toBe(
          'cancel-test',
        );
      } finally {
        await client.close();
      }
    });
  },
);
