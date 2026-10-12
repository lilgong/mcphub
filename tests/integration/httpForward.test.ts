import { buildHttpAuthHeaders } from '../../frontend/src/utils/httpForwardAuth';
import express from 'express';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let resource: Record<string, unknown>;
let permitted = true;
let valid = true;
let shared = false;
let upstreamStatus = 200;
let upstreamHeaders: Record<string, string> = {};
let upstreamBody: Buffer;
let seen: { url?: string; body?: string; authorization?: string; cookie?: string; secret?: string };
const mockFindServer = jest.fn(async () => resource);
const mockFindUser = jest.fn(async () => ({ username: 'admin', isAdmin: true }));
jest.mock('../../src/dao/index.js', () => ({
  getServerDao: () => ({ findById: mockFindServer }),
  getUserDao: () => ({ findByUsername: mockFindUser }),
  getBearerKeyDao: () => ({
    findById: async () => ({
      id: shared ? 'shared-key' : 'group-key',
      enabled: valid,
      kind: 'system',
      accessType: 'all',
      userGroupId: shared ? undefined : 'bench-group',
    }),
  }),
  getGroupDao: () => ({ findByName: async () => null, findById: async () => null }),
  getSystemConfigDao: () => ({
    get: async () => ({
      userGroups: [
        {
          id: 'bench-group',
          enabled: true,
          members: [],
          servers: permitted ? [{ name: 'serper' }] : [],
        },
      ],
    }),
  }),
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({ findById: mockFindServer }),
}));
jest.mock('../../src/services/sseService.js', () => ({
  validateBearerAuth: async (req: express.Request) =>
    valid && req.get('authorization') === 'Bearer hub-test-token'
      ? { valid: true, keyId: shared ? 'shared-key' : 'group-key', keyName: 'test' }
      : { valid: false, reason: 'invalid' },
}));
jest.mock('../../src/services/serverConfigEnvironment.js', () => ({
  expandServerConfig: async (config: unknown) => config,
}));
import { forwardHttp } from '../../src/controllers/httpForwardController.js';
import { forwardingUrl } from '../../src/services/httpForwardService.js';
import { normalizeServerConfigForPersistence } from '../../src/utils/serverConfigPersistence.js';
import { getCallLogs } from '../../src/services/callLogService.js';
import { getCallStats } from '../../src/services/callStatsService.js';

const app = express();
app.all(/^\/http\/([^/]+)(\/.*)?$/, express.raw({ type: () => true, limit: '1mb' }), forwardHttp);
let server: Server;
let audit: string;
let previousAudit: string | undefined;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen = {
      url: req.url,
      body: Buffer.concat(chunks).toString(),
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      secret: String(req.headers['x-api-key'] ?? ''),
    };
    res.writeHead(upstreamStatus, upstreamHeaders);
    res.end(upstreamBody);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  previousAudit = process.env.MCPHUB_AUDIT_LOG_DIR;
});
beforeEach(() => {
  const address = server.address() as { port: number };
  resource = {
    name: 'serper',
    type: 'http-proxy',
    url: `http://127.0.0.1:${address.port}`,
    owner: 'admin',
    headers: { Authorization: 'Bearer upstream-test-secret-1234' },
  };
  permitted = true;
  valid = true;
  shared = false;
  upstreamStatus = 200;
  upstreamHeaders = { 'Content-Type': 'application/json' };
  upstreamBody = Buffer.from('{ "organic": [{"title":"fixture"}], "extra": true }');
  seen = {};
  audit = mkdtempSync(join(tmpdir(), 'mcphub-http-audit-'));
  process.env.MCPHUB_AUDIT_LOG_DIR = audit;
  jest.clearAllMocks();
});
afterEach(() => rmSync(audit, { recursive: true, force: true }));
afterAll(async () => {
  if (previousAudit === undefined) delete process.env.MCPHUB_AUDIT_LOG_DIR;
  else process.env.MCPHUB_AUDIT_LOG_DIR = previousAudit;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
const search = () =>
  request(app)
    .post('/http/serper/serper/search?flag=1')
    .set('Authorization', 'Bearer hub-test-token')
    .set('Cookie', 'client-secret-cookie')
    .set('X-API-KEY', 'client-secret-key')
    .set('Content-Type', 'application/json')
    .send('{ "q": "fixture", "num": 10 }');

it('preserves request bytes, path, query and response JSON; replaces client credentials', async () => {
  const response = await search();
  expect(response.status).toBe(200);
  expect(response.text).toBe(upstreamBody.toString());
  expect(seen).toEqual({
    url: '/serper/search?flag=1',
    body: '{ "q": "fixture", "num": 10 }',
    authorization: 'Bearer upstream-test-secret-1234',
    cookie: undefined,
    secret: '',
  });
  const logs = readdirSync(audit)
    .map((file) => readFileSync(join(audit, file), 'utf8'))
    .join('');
  expect(logs).toContain('credential_id');
  expect(logs).not.toContain('hub-test-token');
  expect(logs).not.toContain('upstream-test-secret');
  expect(logs).not.toContain('fixture');
  const date = new Date().toISOString().slice(0, 10);
  const records = await getCallLogs({
    date,
    status: '200',
    source: 'tool',
    errorsOnly: false,
    server: '',
    page: 1,
    limit: 20,
  });
  expect(records.rows).toHaveLength(1);
  expect(records.rows[0]).toMatchObject({
    server: 'serper',
    httpStatus: 200,
    operation: 'HTTP POST',
  });
  const stats = await getCallStats({
    start: `${date}T00:00:00.000Z`,
    end: `${date}T23:59:59.999Z`,
  });
  expect(stats.total).toBe(1);
});
it('preserves upstream errors and Retry-After without a second upstream attempt', async () => {
  upstreamStatus = 429;
  upstreamHeaders['Retry-After'] = '7';
  upstreamBody = Buffer.from('{"error":"quota"}');
  const response = await search();
  expect(response.status).toBe(429);
  expect(response.headers['retry-after']).toBe('7');
  expect(response.text).toBe(upstreamBody.toString());
  const logs = readdirSync(audit)
    .map((file) => readFileSync(join(audit, file), 'utf8'))
    .join('');
  expect(logs.match(/upstream_started/g)).toHaveLength(1);
  expect(logs).toContain('"http_status":429');
});
it('denies absent keys and group resources not granted', async () => {
  expect((await request(app).post('/http/serper/search').send({ q: 'test' })).status).toBe(401);
  permitted = false;
  expect((await search()).status).toBe(403);
  expect(seen.url).toBeUndefined();
});
it('allows a shared key and observes configuration changes on subsequent requests', async () => {
  shared = true;
  permitted = false;
  resource.headers = { 'X-API-KEY': 'updated-key-5678' };
  expect((await search()).status).toBe(200);
  expect(seen.secret).toBe('updated-key-5678');
  resource.enabled = false;
  expect((await search()).status).toBe(404);
});
it('fails closed when mandatory audit is unavailable', async () => {
  delete process.env.MCPHUB_AUDIT_LOG_DIR;
  expect((await search()).status).toBe(503);
  expect(seen.url).toBeUndefined();
});
it('blocks non-admin upstream connections to internal addresses', async () => {
  mockFindUser.mockResolvedValueOnce({ username: 'user', isAdmin: false });
  expect((await search()).status).toBe(502);
  expect(seen.url).toBeUndefined();
});
it('does not follow redirects or expose upstream cookies/Location', async () => {
  upstreamStatus = 302;
  upstreamHeaders = { Location: 'https://other.example/', 'Set-Cookie': 'secret=1' };
  upstreamBody = Buffer.from('redirect');
  const response = await search();
  expect(response.status).toBe(302);
  expect(response.headers.location).toBeUndefined();
  expect(response.headers['set-cookie']).toBeUndefined();
});
it.each([
  '/../admin',
  '/%2e%2e/admin',
  '/%252e%252e/admin',
  '//other.example/path',
  '/%2f%2fother.example',
  '/path%3fkey=1',
  '/a\\b',
])('rejects unsafe path %s', (path) => {
  expect(() => forwardingUrl('https://yibuapi.com/serper', path)).toThrow();
});
it('preserves an upstream base prefix and normalizes saved HTTP configuration', () => {
  expect(forwardingUrl('https://yibuapi.com/serper', '/search', '?q=1')).toBe(
    'https://yibuapi.com/serper/search?q=1',
  );
  const config = normalizeServerConfigForPersistence({
    type: 'http-proxy',
    url: 'https://yibuapi.com',
    headers: { Authorization: 'Bearer test' },
    command: 'node',
    env: { OTHER: 'value' },
  });
  expect(config.url).toBe('https://yibuapi.com');
  expect(config.headers).toEqual({ Authorization: 'Bearer test' });
  expect(config.command).toBeUndefined();
  expect(config.env).toBeUndefined();
  expect(() =>
    normalizeServerConfigForPersistence({ type: 'http-proxy', url: 'file:///tmp' }),
  ).toThrow();
  expect(
    normalizeServerConfigForPersistence({ type: 'http-proxy', url: '${SERPER_UPSTREAM_URL}' }).url,
  ).toBe('${SERPER_UPSTREAM_URL}');
});

it('shares the configured start interval across simultaneous callers', async () => {
  resource.rateLimit = { enabled: true, minIntervalMs: 80 };
  const started = Date.now();
  const results = await Promise.all([search(), search(), search()]);
  expect(results.every((response) => response.status === 200)).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(140);
});
it('records failed upstream calls in HTTP status filters and statistics', async () => {
  upstreamStatus = 500;
  expect((await search()).status).toBe(500);
  const date = new Date().toISOString().slice(0, 10);
  const logs = await getCallLogs({
    date,
    status: '500',
    source: 'tool',
    errorsOnly: true,
    server: 'serper',
    page: 1,
    limit: 20,
  });
  expect(logs.rows).toHaveLength(1);
  const stats = await getCallStats({
    start: `${date}T00:00:00.000Z`,
    end: `${date}T23:59:59.999Z`,
  });
  expect(stats.errors).toBe(1);
});

it('rechecks group permissions when a queued request is dispatched', async () => {
  resource.rateLimit = { enabled: true, minIntervalMs: 200 };
  await search();
  seen = {};
  const pending = search().then((result) => result);
  await new Promise((resolve) => setTimeout(resolve, 40));
  permitted = false;
  expect((await pending).status).toBe(403);
  expect(seen.url).toBeUndefined();
});

it('uses the generated Bearer or API-key header upstream while retaining Hub client authentication', async () => {
  for (const mode of ['bearer', 'header'] as const) {
    resource.headers = Object.fromEntries(
      buildHttpAuthHeaders({ mode, key: 'entered-key-1234', headerName: 'X-API-KEY' }, []).map(
        (header) => [header.key, header.value],
      ),
    );
    expect((await search()).status).toBe(200);
    if (mode === 'bearer') {
      expect(seen.authorization).toBe('Bearer entered-key-1234');
      expect(seen.secret).toBe('');
    } else {
      expect(seen.authorization).toBeUndefined();
      expect(seen.secret).toBe('entered-key-1234');
    }
  }
});
