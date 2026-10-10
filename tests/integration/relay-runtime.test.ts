import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import express from 'express';
import request from 'supertest';
import {
  RelayRuntimeService,
  relayRuntimeService,
} from '../../src/services/relayRuntimeService.js';
import {
  relayRuntime,
  startRelay,
  stopRelay,
  resetRelayToken,
} from '../../src/controllers/relayRuntimeController.js';
import { getRelayToken, saveAtlasConfig } from '../../src/services/atlasConfigService.js';

jest.mock('../../src/services/atlasConfigService.js', () => ({
  getRelayToken: jest.fn(),
  getAtlasConfig: jest.fn(async () => ({
    policies: {},
    relay: { enabled: true, url: '', timeoutSeconds: 90 },
  })),
  saveAtlasConfig: jest.fn(),
}));
jest.mock('../../src/controllers/atlasController.js', () => ({
  reconnectRelayServers: jest.fn(async () => []),
}));

const originalEnv = { ...process.env };
let directory: string;
let port: number;
let service: RelayRuntimeService;
let token: string;

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-relay-test-'));
  port = await new Promise<number>((resolve) => {
    const socket = createServer();
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') throw new Error('Expected port');
      socket.close(() => resolve(address.port));
    });
  });
  Object.assign(process.env, {
    MCP_RELAY_PORT: String(port),
    MCP_RELAY_BIND: '127.0.0.1',
    MCP_RELAY_URL: `http://127.0.0.1:${port}`,
    MCPHUB_RELAY_LOG_FILE: path.join(directory, 'usage.jsonl'),
    IPWO_PROXY_HOST: 'proxy.test',
    IPWO_PROXY_PORT: '8080',
    IPWO_PROXY_USERNAME: 'fake-account',
    IPWO_PROXY_PASSWORD: 'fake-password',
    IPWO_PROXY_COUNTRY: 'US',
  });
  token = 'synthetic-relay-initial-token';
  jest.mocked(getRelayToken).mockImplementation(async () => token);
  jest.mocked(saveAtlasConfig).mockImplementation(async (_config, value) => {
    if (value) token = value;
  });
  service = new RelayRuntimeService();
});
afterAll(async () => {
  await service.shutdown();
  process.env = originalEnv;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('standalone process rotates credentials without restart and persists audit outside the process', async () => {
  expect((await service.status()).state).toBe('stopped');
  const running = await service.start();
  expect(running).toMatchObject({ state: 'running', healthy: true });
  expect((await service.start()).pid).toBe(running.pid);
  const url = `http://127.0.0.1:${port}`;
  const old = token;
  expect(
    (await fetch(`${url}/v1/limits`, { headers: { Authorization: `Bearer ${old}` } })).status,
  ).toBe(200);
  expect(
    (
      await fetch(`${url}/v1/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${old}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'unauthorized-replacement' }),
      })
    ).status,
  ).toBe(401);
  const reset = await service.resetToken();
  expect(reset).not.toBe(old);
  expect((await service.status()).pid).toBe(running.pid);
  expect(
    (await fetch(`${url}/v1/limits`, { headers: { Authorization: `Bearer ${old}` } })).status,
  ).toBe(401);
  expect(
    (await fetch(`${url}/v1/limits`, { headers: { Authorization: `Bearer ${reset}` } })).status,
  ).toBe(200);
  const audit = fs.readFileSync(path.join(directory, 'usage.jsonl'), 'utf8');
  expect(audit).toContain('token_reset');
  expect(audit).not.toContain(reset);
  expect(audit).not.toContain(old);
  expect((await service.stop()).state).toBe('stopped');
  expect(fs.existsSync(path.join(directory, 'usage.jsonl'))).toBe(true);
  expect((await service.start()).healthy).toBe(true);
  expect(
    (await fetch(`${url}/v1/limits`, { headers: { Authorization: `Bearer ${reset}` } })).status,
  ).toBe(200);
  await service.stop();
});

test('external relay is never stopped, reset or replaced', async () => {
  const external = express();
  external.get('/health', (_req, res) => res.json({ status: 'ok' }));
  const server = external.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    expect((await service.status()).state).toBe('external');
    await expect(service.start()).rejects.toThrow('external relay');
    await expect(service.stop()).rejects.toThrow('External relay');
    await expect(service.resetToken()).rejects.toThrow('External relay');
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('missing executable yields a recoverable error without leaving an owned process', async () => {
  process.env.MCP_RELAY_PYTHON = '/nonexistent/hub-relay-python';
  try {
    await expect(service.start()).rejects.toThrow('Unable to launch');
    expect((await service.status()).state).toBe('failed');
  } finally {
    delete process.env.MCP_RELAY_PYTHON;
  }
});

test('runtime API requires admin before any operation and returns token only on reset', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user: { isAdmin: boolean } }).user = {
      isAdmin: req.header('x-test-admin') === 'yes',
    };
    next();
  });
  app.get('/relay/runtime', relayRuntime);
  app.post('/relay/runtime/start', startRelay);
  app.post('/relay/runtime/stop', stopRelay);
  app.post('/relay/runtime/reset-token', resetRelayToken);
  const state = jest
    .spyOn(relayRuntimeService, 'status')
    .mockResolvedValue({ state: 'stopped', healthy: false, configured: true, missing: [], port });
  const start = jest
    .spyOn(relayRuntimeService, 'start')
    .mockResolvedValue({ state: 'running', healthy: true, configured: true, missing: [], port });
  const stop = jest
    .spyOn(relayRuntimeService, 'stop')
    .mockResolvedValue({ state: 'stopped', healthy: false, configured: true, missing: [], port });
  const reset = jest
    .spyOn(relayRuntimeService, 'resetToken')
    .mockResolvedValue('synthetic-new-token');
  try {
    await request(app).get('/relay/runtime').expect(403);
    for (const action of ['start', 'stop', 'reset-token'])
      await request(app).post(`/relay/runtime/${action}`).expect(403);
    expect(state).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    const status = await request(app).get('/relay/runtime').set('x-test-admin', 'yes').expect(200);
    expect(JSON.stringify(status.body)).not.toContain('token');
    const response = await request(app)
      .post('/relay/runtime/reset-token')
      .set('x-test-admin', 'yes')
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.data.token).toBe('synthetic-new-token');
  } finally {
    state.mockRestore();
    start.mockRestore();
    stop.mockRestore();
    reset.mockRestore();
  }
});
