import { prepareWorkerPackage } from './workerPackages.js';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { closeWorkerProcess, workerSessionCommand } from './workerProcess.js';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { validateServerKey, splitServerKey } from '../utils/catalog.js';
import type { WorkerLaunch } from '../clients/workerStdioTransport.js';

/** A worker has no database, dashboard, group keys, quotas or Docker socket. */
export function createRuntimeWorker(catalog: string, token: string) {
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(catalog) || token.length < 32)
    throw new Error('Worker requires a catalog and a strong control token');
  const sessionCommand = workerSessionCommand();
  type Entry = {
    name?: string;
    transport?: StdioClientTransport;
    group?: number;
    cleanup?: () => Promise<void>;
  };
  const clients = new Map<WebSocket, Entry>();
  const cleanups = new Set<Promise<void>>();
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  const authorized = (value: string | undefined) => {
    const actual = Buffer.from(value || ''),
      expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = createServer((req, res) => {
    if (!authorized(req.headers.authorization)) {
      res.writeHead(401).end();
      return;
    }
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        catalog,
        processes: [...clients.values()]
          .filter((c) => c.transport)
          .map((c) => ({ name: c.name, pid: c.transport?.pid })),
      }),
    );
  });
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 0,
    perMessageDeflate: false,
  });
  server.on('upgrade', (req, socket, head) => {
    if (stopping || req.url !== '/stdio' || !authorized(req.headers.authorization)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    websocket.handleUpgrade(req, socket, head, (ws) => websocket.emit('connection', ws));
  });
  websocket.on('connection', (socket: WebSocket) => {
    if (stopping) {
      socket.terminate();
      return;
    }
    const entry: Entry = {};
    clients.set(socket, entry);
    let starting = false,
      alive = true;
    const send = (value: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };
    const startup = setTimeout(() => socket.close(), 10000);
    let messages = Promise.resolve();
    let cleanup: Promise<void> | undefined;
    entry.cleanup = () => {
      if (!cleanup) {
        cleanup = (async () => {
          // A launch may still be copying files/spawning. Never wait on an MCP's
          // blocked stdin write once its process group is known.
          if (!entry.group) await messages.catch(() => undefined);
          await closeWorkerProcess(entry.transport, entry.group);
        })();
        cleanups.add(cleanup);
        void cleanup.finally(() => cleanups.delete(cleanup!)).catch(() => undefined);
      }
      return cleanup;
    };
    socket.on('pong', () => {
      alive = true;
    });
    socket.on('message', (data) => {
      messages = messages
        .then(async () => {
          if (stopping || socket.readyState !== WebSocket.OPEN) return;
          const frame = JSON.parse(data.toString());
          if (frame.type === 'start' && !starting) {
            starting = true;
            clearTimeout(startup);
            let launch = frame as WorkerLaunch;
            if (
              !validateServerKey(launch.name).valid ||
              splitServerKey(launch.name).catalog !== catalog ||
              typeof launch.command !== 'string' ||
              !launch.command ||
              !Array.isArray(launch.args) ||
              launch.args.some((v) => typeof v !== 'string') ||
              !launch.env ||
              typeof launch.env !== 'object' ||
              Object.values(launch.env).some((v) => typeof v !== 'string') ||
              !Number.isSafeInteger(launch.maxBufferSize) ||
              launch.maxBufferSize < 1
            )
              throw new Error('Invalid worker launch');
            entry.name = launch.name;
            launch = await prepareWorkerPackage(launch, catalog);
            if (socket.readyState !== WebSocket.OPEN) return;
            for (const key of ['SLACK_MCP_CHANNELS_CACHE', 'SLACK_MCP_USERS_CACHE']) {
              const file = launch.env[key];
              if (file) await mkdir(dirname(file), { recursive: true, mode: 0o700 });
            }
            await mkdir(process.env.HOME || '/app/data/home', { recursive: true, mode: 0o700 });
            const transport = new StdioClientTransport({
              // The SDK spawns a non-detached child. setsid executes in that
              // same PID, giving this MCP a group/session separate from worker.
              command: sessionCommand,
              args: ['--', launch.command, ...launch.args],
              env: {
                ...launch.env,
                PATH: process.env.PATH || '',
                HOME: process.env.HOME || '/app/data/home',
              },
              cwd: process.cwd(),
              stderr: 'pipe',
              maxBufferSize: launch.maxBufferSize,
            });
            entry.transport = transport;
            transport.onmessage = (message) => send({ type: 'mcp', message });
            transport.onerror = () => {
              send({ type: 'error' });
              socket.close();
            };
            transport.onclose = () => socket.close();
            transport.stderr?.on('data', (chunk: Buffer) =>
              send({ type: 'stderr', text: chunk.toString() }),
            );
            await transport.start();
            entry.group = transport.pid ?? undefined;
            if (socket.readyState !== WebSocket.OPEN || stopping) return;
            send({ type: 'ready' });
          } else if (frame.type === 'mcp' && entry.transport)
            await entry.transport.send(frame.message);
          else throw new Error('Invalid worker protocol');
        })
        .catch((error: unknown) => {
          const code =
            error && typeof error === 'object' && 'code' in error
              ? String(error.code)
              : 'worker_launch_failed';
          console.warn(
            'MCP worker lifecycle failure',
            JSON.stringify({ catalog, server: entry.name, code }),
          );
          send({ type: 'error' });
          socket.close();
        });
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearTimeout(startup);
      clearInterval(heartbeat);
      clients.delete(socket);
      void entry.cleanup!().catch(() => {
        console.warn('MCP worker cleanup failed', JSON.stringify({ catalog, server: entry.name }));
      });
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 15000);
    heartbeat.unref();
  });
  return {
    server,
    close: () => {
      if (!shutdown) {
        stopping = true;
        shutdown = (async () => {
          const entries = [...clients.values()];
          for (const socket of clients.keys()) socket.terminate();
          await Promise.allSettled(entries.map((entry) => entry.cleanup!()));
          await Promise.allSettled([...cleanups]);
          websocket.close();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        })();
      }
      return shutdown;
    },
  };
}
