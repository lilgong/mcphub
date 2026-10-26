import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  JsonFileDaoFactory,
  setDaoFactory,
  getBearerKeyDao,
  getUserDao,
  getCredentialBindingDao,
  getServerDao,
} from '../../src/dao/DaoFactory.js';
import {
  relayLimits,
  checkAtlasRelay,
  getAtlasSettings,
  updateAtlasSettings,
  getAtlasRelayRuntime,
} from '../../src/controllers/atlasController.js';
import {
  BASE_POLICY,
  saveAtlasConfig,
  getRelayEnvironment,
} from '../../src/services/atlasConfigService.js';
import { closeServer, initializeClientsFromSettings } from '../../src/services/mcpService.js';
import { getServerEnvironment } from '../../src/services/serverConfigEnvironment.js';
import { relayRuntimeService } from '../../src/services/relayRuntimeService.js';
import { getAtlasConfig } from '../../src/services/atlasConfigService.js';
import { clearSettingsCache } from '../../src/config/index.js';
import { setCachedSystemConfig } from '../../src/utils/systemConfigCache.js';

jest.mock('../../src/services/mcpService.js', () => ({
  closeServer: jest.fn(),
  initializeClientsFromSettings: jest.fn(),
}));
let directory: string;
const originalEnv = { ...process.env };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user: { isAdmin: boolean } }).user = {
    isAdmin: req.header('x-test-admin') === 'yes',
  };
  next();
});
app.post('/api/relay/health', checkAtlasRelay);
app.get('/api/relay/limits', relayLimits);
app.put('/api/relay/limits', relayLimits);
app.get('/api/atlas', getAtlasSettings);
app.put('/api/atlas', updateAtlasSettings);
app.get('/atlas/relay-runtime', getAtlasRelayRuntime);
const config = {
  policies: { brave: { ...BASE_POLICY } },
  relay: { enabled: true, url: 'http://relay.example:9123', timeoutSeconds: 90 },
};

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-atlas-config-'));
  process.env.MCPHUB_SETTING_PATH = path.join(directory, 'settings.json');
  process.env.USE_DB = 'false';
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  fs.writeFileSync(
    process.env.MCPHUB_SETTING_PATH,
    JSON.stringify({
      mcpServers: {},
      users: [
        { username: 'admin', password: 'unused', isAdmin: true },
        { username: 'member', password: 'unused', isAdmin: false },
      ],
      systemConfig: {},
    }),
  );
  setDaoFactory(new JsonFileDaoFactory());
  clearSettingsCache();
  await saveAtlasConfig(config, 'synthetic-relay-secret');
});
afterAll(() => {
  process.env = originalEnv;
  setCachedSystemConfig(null);
  clearSettingsCache();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('admin page never returns tokens and stores relay credentials encrypted', async () => {
  await request(app).get('/api/atlas').expect(403);
  const response = await request(app).get('/api/atlas').set('x-test-admin', 'yes').expect(200);
  expect(response.body.data.hasRelayToken).toBe(true);
  expect(JSON.stringify(response.body)).not.toContain('synthetic-relay-secret');
  const binding = await getCredentialBindingDao().get('$atlas-relay', '$system');
  expect(binding).toBeDefined();
  expect(JSON.stringify(binding)).not.toContain('synthetic-relay-secret');
  await request(app)
    .put('/api/atlas')
    .set('x-test-admin', 'yes')
    .send({ config: { ...config, policies: { brave: { ...BASE_POLICY, concurrency: 0 } } } })
    .expect(400);
  expect(await getRelayEnvironment('pubmed')).toMatchObject({
    MCP_RELAY_TOKEN: 'synthetic-relay-secret',
  });
});

test('runtime requires live scoped operator access; ordinary users cannot read the shared relay', async () => {
  const dao = getBearerKeyDao();
  const key = await dao.create({
    name: 'test',
    token: 'synthetic-operator',
    kind: 'system',
    enabled: true,
    accessType: 'servers',
    allowedServers: ['pubmed'],
    allowedGroups: [],
  });
  await request(app).get('/atlas/relay-runtime?server=pubmed').expect(403);
  await request(app)
    .get('/atlas/relay-runtime?server=arxiv')
    .auth(key.token, { type: 'bearer' })
    .expect(403);
  const response = await request(app)
    .get('/atlas/relay-runtime?server=pubmed')
    .auth(key.token, { type: 'bearer' })
    .expect(200);
  expect(response.body.data.MCP_RELAY_TOKEN).toBe('synthetic-relay-secret');
  expect(response.headers['cache-control']).toBe('no-store');
  await dao.update(key.id, { enabled: false });
  await request(app)
    .get('/atlas/relay-runtime?server=pubmed')
    .auth(key.token, { type: 'bearer' })
    .expect(403);
  const personal = await dao.create({
    name: 'personal',
    token: 'synthetic-personal',
    kind: 'user',
    owner: 'member',
    enabled: true,
    accessType: 'all',
    allowedGroups: [],
    allowedServers: [],
  });
  await request(app)
    .get('/atlas/relay-runtime?server=pubmed')
    .auth(personal.token, { type: 'bearer' })
    .expect(403);
  await dao.update(personal.id, { owner: 'admin' });
  await request(app)
    .get('/atlas/relay-runtime?server=pubmed')
    .auth(personal.token, { type: 'bearer' })
    .expect(200);
  await getUserDao().delete('admin');
  await request(app)
    .get('/atlas/relay-runtime?server=pubmed')
    .auth(personal.token, { type: 'bearer' })
    .expect(403);
});

test('only trusted relay servers receive the connection token', async () => {
  expect(await getServerEnvironment({ owner: 'member', name: 'pubmed' })).not.toHaveProperty(
    'MCP_RELAY_TOKEN',
    'synthetic-relay-secret',
  );
  expect(await getServerEnvironment({ name: 'unrelated' })).not.toHaveProperty(
    'MCP_RELAY_TOKEN',
    'synthetic-relay-secret',
  );
  expect(
    await getServerEnvironment({ name: 'pubmed', env: { MCPHUB_RELAY_ADAPTER: 'fetch-v1' } }),
  ).toHaveProperty('MCP_RELAY_TOKEN', 'synthetic-relay-secret');
  expect(
    await getServerEnvironment({ name: 'pubmed', type: 'stdio', args: ['-y', 'native-pubmed'] }),
  ).not.toHaveProperty('MCP_RELAY_TOKEN');
  await expect(getServerEnvironment({ name: 'native', relay: { enabled: true } })).rejects.toThrow(
    'no /v1/fetch relay adapter',
  );
  const compatible = { name: 'custom-benchmark-search', env: { MCPHUB_RELAY_ADAPTER: 'fetch-v1' } };
  expect(await getServerEnvironment(compatible)).toHaveProperty(
    'MCP_RELAY_TOKEN',
    'synthetic-relay-secret',
  );
  const off = await getServerEnvironment({ ...compatible, relay: { enabled: false } });
  expect(off.MCP_RELAY_URL).toBe('');
  expect(off.MCP_RELAY_TOKEN).toBe('');
  expect(Object.keys(await getRelayEnvironment('pubmed')).sort()).toEqual([
    'MCP_RELAY_TIMEOUT_SECONDS',
    'MCP_RELAY_TOKEN',
    'MCP_RELAY_URL',
  ]);
  await request(app)
    .put('/api/atlas')
    .set('x-test-admin', 'yes')
    .send({ config, relayToken: '' })
    .expect(200);
  expect(await getRelayEnvironment('pubmed')).toHaveProperty(
    'MCP_RELAY_TOKEN',
    'synthetic-relay-secret',
  );
  await saveAtlasConfig({ ...config, relay: { ...config.relay, enabled: false } });
  expect(await getRelayEnvironment('pubmed')).toHaveProperty('MCP_RELAY_TOKEN', '');
});

test('relay limits require admin authorization and never return the shared token', async () => {
  await saveAtlasConfig(config, 'synthetic-relay-secret');
  await request(app).get('/api/relay/limits').expect(403);
  await request(app).put('/api/relay/limits').send({ limits: {} }).expect(403);
  const originalFetch = global.fetch;
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({ limits: { arxiv: { minIntervalMs: 3000 } } }),
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  try {
    const response = await request(app)
      .get('/api/relay/limits')
      .set('x-test-admin', 'yes')
      .expect(200);
    expect(response.body.data.limits.arxiv.minIntervalMs).toBe(3000);
    expect(JSON.stringify(response.body)).not.toContain('synthetic-relay-secret');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('relay settings reconnect compatible implementations by capability, including renamed services', async () => {
  await getServerDao().create({
    name: 'other-suite-search',
    type: 'stdio',
    command: 'node',
    enabled: true,
    env: { MCPHUB_RELAY_ADAPTER: 'fetch-v1' },
  });
  await getServerDao().create({
    name: 'wikipedia',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'native-wikipedia'],
    enabled: true,
  });
  jest.mocked(closeServer).mockClear();
  jest.mocked(initializeClientsFromSettings).mockClear();
  await request(app)
    .put('/api/atlas')
    .set('x-test-admin', 'yes')
    .send({ config, relayToken: 'new-synthetic-relay-secret' })
    .expect(200);
  expect(closeServer).toHaveBeenCalledWith('other-suite-search');
  expect(initializeClientsFromSettings).toHaveBeenCalledWith(false, 'other-suite-search');
  expect(closeServer).not.toHaveBeenCalledWith('wikipedia');
});

test('external relay settings save without local proxy credentials', async () => {
  const snapshot = { ...process.env };
  for (const key of [
    'IPWO_PROXY_HOST',
    'IPWO_PROXY_PORT',
    'IPWO_PROXY_USERNAME',
    'IPWO_PROXY_PASSWORD',
  ])
    delete process.env[key];
  const status = jest.spyOn(relayRuntimeService, 'status').mockResolvedValue({
    state: 'external',
    healthy: true,
    configured: true,
    missing: [],
    port: 3986,
  });
  try {
    const response = await request(app)
      .put('/api/atlas')
      .set('x-test-admin', 'yes')
      .send({ config, relayToken: '  external-test-token  ' })
      .expect(200);
    expect(response.body.success).toBe(true);
    expect(await getRelayEnvironment('pubmed')).toHaveProperty(
      'MCP_RELAY_TOKEN',
      'external-test-token',
    );
  } finally {
    status.mockRestore();
    process.env = snapshot;
    await saveAtlasConfig(config, 'synthetic-relay-secret');
  }
});

test('save reports a missing token explicitly without persisting enabled relay settings', async () => {
  const previous = await getAtlasConfig();
  await getCredentialBindingDao().delete({ serverName: '$atlas-relay', username: '$system' });
  try {
    const response = await request(app)
      .put('/api/atlas')
      .set('x-test-admin', 'yes')
      .send({ config, relayToken: '' })
      .expect(400);
    expect(response.body.message).toBe('A relay token is required');
    expect(await getAtlasConfig()).toEqual(previous);
    const invalid = await request(app)
      .put('/api/atlas')
      .set('x-test-admin', 'yes')
      .send({ config, relayToken: 'Bearer do-not-echo-this-token' })
      .expect(400);
    expect(invalid.body.message).toContain('without the Bearer prefix');
    expect(JSON.stringify(invalid.body)).not.toContain('do-not-echo-this-token');
  } finally {
    await saveAtlasConfig(config, 'synthetic-relay-secret');
  }
});

test('health checks the unsaved form address and rejects a Hub health response', async () => {
  const previous = await getAtlasConfig();
  const originalFetch = global.fetch;
  const mock = jest
    .fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok' }) });
  global.fetch = mock as unknown as typeof fetch;
  const draft = {
    ...config,
    relay: { enabled: true, url: 'http://127.0.0.1:19123', timeoutSeconds: 90 },
  };
  try {
    await request(app).post('/api/relay/health').send({ config: draft }).expect(403);
    await request(app)
      .post('/api/relay/health')
      .set('x-test-admin', 'yes')
      .send({ config: draft })
      .expect(200);
    expect(mock.mock.calls[0][0]).toBe('http://127.0.0.1:19123/health');
    expect(await getAtlasConfig()).toEqual(previous);
    mock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'healthy' }) });
    const wrong = await request(app)
      .post('/api/relay/health')
      .set('x-test-admin', 'yes')
      .send({ config: draft })
      .expect(400);
    expect(wrong.body.message).toContain('not a Relay');
  } finally {
    global.fetch = originalFetch;
  }
});

test('admin relay status reports per-server routing metadata without exposing provider values', async () => {
  await getServerDao().create({
    name: 'atlas::relay-status-task',
    enabled: true,
    targets: [
      { path: 'task/default', kind: 'task', config: { env: { MCPHUB_RELAY_ADAPTER: 'fetch-v1' } } },
    ],
  });
  await getServerDao().create({
    name: 'atlas::relay-status-disabled',
    enabled: true,
    command: 'node',
    env: { MCPHUB_RELAY_ADAPTER: 'fetch-v1', PROVIDER_KEY: 'status-must-not-return-me' },
    relay: { enabled: false },
  });
  const response = await request(app).get('/api/atlas').set('x-test-admin', 'yes').expect(200);
  expect(response.body.data.serverRelay['atlas::relay-status-task']).toBe('task');
  expect(response.body.data.serverRelay['atlas::relay-status-disabled']).toBeUndefined();
  expect(JSON.stringify(response.body)).not.toContain('status-must-not-return-me');
  await request(app).get('/api/atlas').expect(403);
});
