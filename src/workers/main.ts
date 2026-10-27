import { createRuntimeWorker } from './runtimeWorker.js';
const worker = createRuntimeWorker(
  process.env.MCPHUB_WORKER_CATALOG || '',
  process.env.MCPHUB_WORKER_TOKEN || '',
);
worker.server.listen(Number(process.env.PORT || 3100), process.env.BIND || '0.0.0.0', () => {
  console.log(`MCP execution worker ready for ${process.env.MCPHUB_WORKER_CATALOG}`);
});
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void worker.close().finally(() => process.exit(0));
  });
