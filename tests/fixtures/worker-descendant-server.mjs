import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
const [mode, directory] = process.argv.slice(2);
const child = (next) =>
  spawn(process.execPath, [fileURLToPath(import.meta.url), next, directory], {
    stdio: 'ignore',
    detached: process.env.WORKER_TEST_DETACH === 'true',
  });
if (mode === 'child' || mode === 'grandchild') {
  process.on('SIGTERM', () => {});
  writeFileSync(join(directory, mode + '.pid'), String(process.pid));
  if (mode === 'child') child('grandchild');
  setInterval(() => {}, 1000);
} else {
  writeFileSync(join(directory, 'root.pid'), String(process.pid));
  child('child');
  const server = new Server(
    { name: 'descendant-fixture', version: '1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler('tools/list', async () => ({
    tools: ['identity', 'exit'].map((name) => ({ name, inputSchema: { type: 'object' } })),
  }));
  server.setRequestHandler('tools/call', async (request) => {
    if (request.params.name === 'exit') setTimeout(() => process.exit(0), 10);
    return { content: [{ type: 'text', text: 'alive' }] };
  });
  await server.connect(new StdioServerTransport());
}
