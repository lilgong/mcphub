import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { findPackageRoot } from '../utils/path.js';
import { setTimeout as delay } from 'node:timers/promises';
import { getAtlasConfig, getRelayToken, saveAtlasConfig } from './atlasConfigService.js';
import { logger } from '../utils/logger.js';
import type { RelayRuntimeStatus } from '../types/relayRuntime.js';

export class RelayRuntimeError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

const PROXY_KEYS = [
  'IPWO_PROXY_HOST',
  'IPWO_PROXY_PORT',
  'IPWO_PROXY_USERNAME',
  'IPWO_PROXY_PASSWORD',
];
const RELAY_ENV_KEYS = [
  ...PROXY_KEYS,
  'IPWO_PROXY_COUNTRY',
  'MCP_RELAY_MIN_INTERVAL_SECONDS',
  'MCP_RELAY_UPSTREAM_TIMEOUT_SECONDS',
  'MCP_RELAY_MAX_RESPONSE_BYTES',
  'MCP_RELAY_USER_AGENT',
];

/** Controls only the child created by this Hub; never kills an external relay. */
export class RelayRuntimeService {
  private child?: ChildProcess;
  private instance = '';
  private controlToken = '';
  private busy = false;
  private lastError?: string;

  private options() {
    const port = Number(process.env.MCP_RELAY_PORT || '3985');
    const bind = process.env.MCP_RELAY_BIND || '0.0.0.0';
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !['0.0.0.0', '127.0.0.1', '::', '::1'].includes(bind)
    )
      throw new RelayRuntimeError('Invalid MCP_RELAY_BIND or MCP_RELAY_PORT', 400);
    const log = path.resolve(
      process.env.MCPHUB_RELAY_LOG_FILE ||
        process.env.MCP_RELAY_USAGE_LOG ||
        'data/relay/usage.jsonl',
    );
    return {
      port,
      bind,
      log,
      local: `http://${bind.includes(':') ? '[::1]' : '127.0.0.1'}:${port}`,
    };
  }

  private async health(url: string): Promise<{ healthy: boolean; instance?: string } | undefined> {
    try {
      const response = await fetch(`${url.replace(/\/+$/, '')}/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(800),
      });
      const body = (await response.json()) as { status?: string; instance_id?: string };
      if (!['ok', 'blocked'].includes(body.status || '')) return undefined;
      return { healthy: response.ok, instance: body.instance_id };
    } catch {
      return undefined;
    }
  }

  async status(): Promise<RelayRuntimeStatus> {
    const options = this.options();
    const missing = PROXY_KEYS.filter((key) => !process.env[key]?.trim());
    if (!(await getRelayToken())) missing.push('MCP_RELAY_TOKEN');
    const local = await this.health(options.local);
    const owned =
      Boolean(this.child?.pid) && this.child?.exitCode === null && this.child?.signalCode === null;
    const external = !owned
      ? local || (await this.health((await getAtlasConfig()).relay.url))
      : undefined;
    return {
      state: owned ? 'running' : external ? 'external' : this.lastError ? 'failed' : 'stopped',
      healthy: owned
        ? Boolean(local?.instance === this.instance && local.healthy)
        : Boolean(external?.healthy),
      configured: missing.length === 0,
      missing,
      port: options.port,
      ...(owned ? { pid: this.child?.pid } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new RelayRuntimeError('Another relay operation is in progress');
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }

  async start(): Promise<RelayRuntimeStatus> {
    return this.exclusive(async () => {
      const current = await this.status();
      if (current.state === 'running') return current;
      if (current.state === 'external')
        throw new RelayRuntimeError(
          'An external relay is running; keep it until migration is ready',
        );
      if (!current.configured)
        throw new RelayRuntimeError(`Missing relay settings: ${current.missing.join(', ')}`, 400);
      const options = this.options();
      await new Promise<void>((resolve, reject) => {
        const socket = createServer();
        socket.once('error', () => reject(new RelayRuntimeError('Relay port is already in use')));
        socket.listen(options.port, options.bind, () => socket.close(() => resolve()));
      });
      mkdirSync(path.dirname(options.log), { recursive: true });
      const token = await getRelayToken();
      this.instance = randomBytes(16).toString('hex');
      this.controlToken = randomBytes(32).toString('base64url');
      this.lastError = undefined;
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PYTHONUNBUFFERED: '1',
      };
      for (const key of RELAY_ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, {
        MCP_RELAY_TOKEN: token,
        MCP_RELAY_BIND: options.bind,
        MCP_RELAY_PORT: String(options.port),
        MCP_RELAY_USAGE_LOG: options.log,
        MCPHUB_RELAY_INSTANCE_ID: this.instance,
        MCPHUB_RELAY_CONTROL_TOKEN: this.controlToken,
      });
      const child = spawn(
        process.env.MCP_RELAY_PYTHON || 'python3',
        [path.join(findPackageRoot() || process.cwd(), 'relay', 'egress_relay.py')],
        { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
      );
      this.child = child;
      const log = (chunk: Buffer) => {
        let text = chunk.toString().slice(0, 4096);
        for (const secret of [token, ...PROXY_KEYS.map((key) => process.env[key] || '')])
          if (secret) text = text.split(secret).join('[REDACTED]');
        logger.log(`[RELAY] ${text.trim()}`);
      };
      child.stdout?.on('data', log);
      child.stderr?.on('data', log);
      child.on('error', () => {
        this.lastError = 'Unable to launch the relay Python process';
      });
      child.on('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.lastError = `Relay exited (${signal || code}); check runtime logs`;
      });
      try {
        for (let attempt = 0; attempt < 50; attempt++) {
          if (this.lastError || child.exitCode !== null || child.signalCode !== null) break;
          const health = await this.health(options.local);
          if (health?.instance === this.instance) {
            const config = await getAtlasConfig();
            await saveAtlasConfig(
              {
                ...config,
                relay: {
                  ...config.relay,
                  enabled: true,
                  url: process.env.MCP_RELAY_URL || config.relay.url || options.local,
                },
              },
              token,
            );
            return await this.status();
          }
          await delay(100);
        }
        throw new RelayRuntimeError(
          this.lastError || 'Relay did not become ready; check runtime logs',
          502,
        );
      } catch (error) {
        await this.stopChild();
        this.lastError =
          error instanceof RelayRuntimeError ? error.message : 'Relay startup failed';
        throw error;
      }
    });
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  async stop(): Promise<RelayRuntimeStatus> {
    return this.exclusive(async () => {
      if ((await this.status()).state === 'external')
        throw new RelayRuntimeError('External relay cannot be stopped by this Hub');
      await this.stopChild();
      this.lastError = undefined;
      return this.status();
    });
  }

  async resetToken(): Promise<string> {
    return this.exclusive(async () => {
      const status = await this.status();
      if (status.state === 'external')
        throw new RelayRuntimeError('External relay token cannot be reset by this Hub');
      const oldToken = await getRelayToken();
      const token = randomBytes(32).toString('base64url');
      const options = this.options();
      const replace = async (from: string, to: string) => {
        const response = await fetch(`${options.local}/v1/token`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${from}`,
            'Content-Type': 'application/json',
            'X-MCPHub-Control': this.controlToken,
          },
          body: JSON.stringify({ token: to }),
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new RelayRuntimeError('Relay rejected the token update', 502);
      };
      if (status.state === 'running') await replace(oldToken, token);
      try {
        await saveAtlasConfig(await getAtlasConfig(), token);
      } catch (error) {
        if (status.state === 'running') await replace(token, oldToken);
        throw error;
      }
      return token;
    });
  }

  async shutdown(): Promise<void> {
    await this.stopChild();
  }
}

export const relayRuntimeService = new RelayRuntimeService();
