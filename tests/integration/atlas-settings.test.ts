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
} from '../../src/dao/DaoFactory.js';
import {
  relayLimits,
  getAtlasSettings,
  updateAtlasSettings,
  getAtlasRelayRuntime,
} from '../../src/controllers/atlasController.js';
import {
  BASE_POLICY,
  saveAtlasConfig,
  getRelayEnvironment,
} from '../../src/services/atlasConfigService.js';
import { getServerEnvironment } from '../../src/services/serverConfigEnvironment.js';
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
    PUBMED_RELAY_TOKEN: 'synthetic-relay-secret',
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
  expect(response.body.data.PUBMED_RELAY_TOKEN).toBe('synthetic-relay-secret');
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
    'PUBMED_RELAY_TOKEN',
    'synthetic-relay-secret',
  );
  expect(await getServerEnvironment({ name: 'unrelated' })).not.toHaveProperty(
    'PUBMED_RELAY_TOKEN',
    'synthetic-relay-secret',
  );
  expect(await getServerEnvironment({ name: 'pubmed' })).toHaveProperty(
    'PUBMED_RELAY_TOKEN',
    'synthetic-relay-secret',
  );
  await request(app)
    .put('/api/atlas')
    .set('x-test-admin', 'yes')
    .send({ config, relayToken: '' })
    .expect(200);
  expect(await getRelayEnvironment('pubmed')).toHaveProperty(
    'PUBMED_RELAY_TOKEN',
    'synthetic-relay-secret',
  );
  await saveAtlasConfig({ ...config, relay: { ...config.relay, enabled: false } });
  expect(await getRelayEnvironment('pubmed')).toHaveProperty('PUBMED_RELAY_TOKEN', '');
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
