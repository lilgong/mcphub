import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { RuntimeWorker } from '../services/runtimeWorkerService.js';

type Message = Parameters<StdioClientTransport['send']>[0];
export interface WorkerLaunch {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  maxBufferSize: number;
  startupTimeoutMs?: number;
}

/** Raw MCP bridge: preserve JSON-RPC, notifications and stdio recovery semantics. */
export class WorkerStdioTransport extends StdioClientTransport {
  private socket?: WebSocket;
  private output = new PassThrough();
  readonly workerId: string;
  constructor(
    private worker: RuntimeWorker,
    private launch: WorkerLaunch,
  ) {
    super({ command: launch.command });
    this.workerId = worker.id;
  }
  override get stderr(): PassThrough {
    return this.output;
  }
  // Remote PIDs must never be passed to the Hub's local process-tree killer.
  override get pid(): null {
    return null;
  }
  override async start(): Promise<void> {
    if (this.socket) throw new Error('Worker transport already started');
    const socket = new WebSocket(this.worker.url, {
      headers: { Authorization: `Bearer ${this.worker.token}` },
      handshakeTimeout: 10000,
      maxPayload: 0,
      perMessageDeflate: false,
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error('Runtime worker startup timed out'));
        socket.terminate();
      }, this.launch.startupTimeoutMs ?? 300000);
      socket.on('open', () => socket.send(JSON.stringify({ type: 'start', ...this.launch })));
      socket.on('message', (data) => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame.type === 'ready') {
            ready = true;
            clearTimeout(timer);
            resolve();
          } else if (frame.type === 'mcp') this.onmessage?.(frame.message as Message);
          else if (frame.type === 'stderr') this.output.write(String(frame.text));
          else if (frame.type === 'error') {
            const error = new Error('Runtime worker could not start or maintain MCP');
            clearTimeout(timer);
            reject(error);
            this.onerror?.(error);
            socket.close();
          }
        } catch {
          this.onerror?.(new Error('Invalid runtime worker frame'));
          socket.close();
        }
      });
      socket.on('error', () => {
        const error = new Error(`Runtime worker ${this.worker.id} unavailable`);
        clearTimeout(timer);
        reject(error);
        this.onerror?.(error);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        if (!ready)
          reject(new Error(`Runtime worker ${this.worker.id} disconnected during startup`));
        this.output.end();
        this.onclose?.();
      });
    });
  }
  override async send(message: Message): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('Connection closed');
    await new Promise<void>((resolve, reject) =>
      this.socket!.send(JSON.stringify({ type: 'mcp', message }), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  override async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 2000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  }
}
