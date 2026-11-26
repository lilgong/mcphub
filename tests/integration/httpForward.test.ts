import { buildHttpAuthHeaders } from '../../frontend/src/utils/httpForwardAuth';
import express from 'express';
import request from 'supertest';
import { gzipSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDurableAudit } from '../../src/services/durableAuditService.js';

jest.mock('../../src/services/durableAuditService.js', () => {
  const actual = jest.requireActual('../../src/services/durableAuditService.js');
  return { ...actual, appendDurableAudit: jest.fn(actual.appendDurableAudit) };
});

const mockActivity = jest.fn(async () => undefined);
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: () => ({ logToolCall: mockActivity }),
}));
let resource: Record<string, unknown>;
let permitted = true;
let valid = true;
let shared = false;
let upstreamStatus = 200;
let upstreamHeaders: Record<string, string> = {};
let upstreamBody: Buffer;
let echoBody = false;
let seenHeaders: import('node:http').IncomingHttpHeaders;
let seen: { url?: string; body?: string; authorization?: string; cookie?: string; secret?: string };
const mockFindServer = jest.fn(async () => resource);
const mockFindUser = jest.fn(async () => ({ username: 'admin', isAdmin: true }));
jest.mock('../../src/dao/index.js', () => ({
  getServerDao: () => ({ findById: mockFindServer, findAll: async () => [resource] }),
  getUserDao: () => ({ findByUsername: mockFindUser }),
  getBearerKeyDao: () => ({
    findById: async () => ({
      id: shared ? 'shared-key' : 'group-key',
      enabled: valid,
      kind: 'system',
      owner: shared ? undefined : 'admin',
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
          owner: 'admin',
          servers: permitted ? [{ name: 'serper' }] : [],
        },
      ],
    }),
  }),
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({ findById: mockFindServer, findAll: async () => [resource] }),
}));
jest.mock('../../src/services/sseService.js', () => ({
  validateBearerAuth: async (req: express.Request) =>
    valid && req.get('authorization') === 'Bearer hub-test-token'
      ? {
          valid: true,
          keyId: shared ? 'shared-key' : 'group-key',
          keyName: 'test',
          user: shared ? undefined : { username: 'admin', isAdmin: true },
        }
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
app.all(/^\/http\/([^/]+)(\/.*)?$/, forwardHttp);
let server: Server;
let audit: string;
let previousAudit: string | undefined;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seenHeaders = req.headers;
    seen = {
      url: req.url,
      body: Buffer.concat(chunks).toString(),
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      secret: String(req.headers['x-api-key'] ?? ''),
    };
    res.writeHead(upstreamStatus, upstreamHeaders);
    res.end(echoBody ? Buffer.concat(chunks) : upstreamBody);
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
  echoBody = false;
  audit = mkdtempSync(join(tmpdir(), 'mcphub-http-audit-'));
  process.env.MCPHUB_AUDIT_LOG_DIR = audit;
  jest.clearAllMocks();
  mockFindUser.mockResolvedValue({ username: 'admin', isAdmin: true });
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
  expect(mockActivity).toHaveBeenCalledTimes(1);
  expect(mockActivity).toHaveBeenCalledWith(
    expect.objectContaining({
      server: 'serper',
      status: 'success',
      keyId: 'group-key',
      hasCredentialTemplate: true,
    }),
  );
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
  expect(logs).toContain('upstream_credentials');
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

it('does not send upstream credentials when durable upstream admission fails', async () => {
  const actual = jest.requireActual('../../src/services/durableAuditService.js');
  jest.mocked(appendDurableAudit).mockImplementation((file, record) => {
    if ((record as { event?: string }).event === 'upstream_started')
      return Promise.reject(new Error('audit storage unavailable'));
    return actual.appendDurableAudit(file, record);
  });
  try {
    await search().expect(503);
    expect(seen).toEqual({});
  } finally {
    jest.mocked(appendDurableAudit).mockImplementation(actual.appendDurableAudit);
  }
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
  mockFindUser.mockResolvedValue({ username: 'admin', isAdmin: false });
  expect((await search()).status).toBe(502);
  expect(seen.url).toBeUndefined();
});
it('leaves redirects to the client, retaining a Hub-routed Location and isolating cookies', async () => {
  upstreamStatus = 302;
  upstreamHeaders = { Location: 'https://other.example/', 'Set-Cookie': 'secret=1' };
  upstreamBody = Buffer.from('redirect');
  const response = await search();
  expect(response.status).toBe(302);
  expect(response.headers.location).toBe('https://other.example/');
  expect(response.headers['set-cookie']).toBeUndefined();
});
it.each(['/../admin', '/%2e%2e/admin', '//other.example/path', '/%2f%2fother.example', '/a\\b'])(
  'rejects unsafe path %s',
  (path) => {
    expect(() => forwardingUrl('https://yibuapi.com/serper', path)).toThrow();
  },
);
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

it('audits normalized upstream credentials for serper suffix names without copying the Hub key', async () => {
  permitted = true;
  shared = true;
  resource = {
    ...resource,
    name: 'serper-a',
    headers: { Authorization: 'Bearer key-a', 'X-API-KEY': 'key-a' },
  };
  await request(app)
    .post('/http/serper-a/search')
    .set('Authorization', 'Bearer hub-test-token')
    .send('{}')
    .expect(200);
  const records = readdirSync(audit).flatMap((file) =>
    readFileSync(join(audit, file), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  );
  const started = records.find((r) => r.event === 'upstream_started');
  const finished = records.find((r) => r.event === 'upstream_finished');
  expect(started.server).toBe('serper-a');
  expect(finished.upstream_request_id).toBe(started.upstream_request_id);
  const credentials = JSON.parse(finished.upstream_credentials);
  expect(credentials).toHaveLength(2);
  expect(credentials[0].id).toBe(credentials[1].id);
  const { createHash } = await import('node:crypto');
  const id = createHash('sha256').update('key-a').digest('hex').slice(0, 16);
  expect(credentials[0].id).toBe(id);
  expect(finished.http_status).toBe(200);
  const raw = JSON.stringify(records);
  expect(raw).not.toContain('hub-test-token');
  expect(raw).not.toContain('Bearer key-a');
  const { getUpstreamStats } = await import('../../src/services/upstreamStatsService');
  const now = new Date();
  const stats = await getUpstreamStats({
    start: new Date(+now - 60000).toISOString(),
    end: new Date(+now + 60000).toISOString(),
    credentialId: id,
  });
  expect(stats.rows.find((r) => r.server === 'serper-a')?.calls).toBe(1);
});

it('forwards a Sheets range containing encoded spaces to the HTTP upstream', async () => {
  const path = '/v4/spreadsheets/test/values/%27Text%20and%20Image%27';
  const response = await request(app)
    .get('/http/serper' + path + '?majorDimension=ROWS')
    .set('Authorization', 'Bearer hub-test-token');
  expect(response.status).toBe(200);
  expect(response.text).toBe(upstreamBody.toString());
  expect(decodeURIComponent(seen.url!)).toBe(decodeURIComponent(path) + '?majorDimension=ROWS');
  expect(seen.url).toContain('Text%20and%20Image');
  expect(seen.authorization).toBe('Bearer upstream-test-secret-1234');
});

it.each([
  '/objects/folder%2Ffile.csv',
  '/objects/folder%2F..%2Ffile.csv',
  '/objects/100%25.csv',
  '/objects/hello%3Fworld',
  '/objects/hello%23world',
  '/objects/%252e%252e',
  '/objects/literal%252Fname',
  '/objects/%E4%B8%AD%E6%96%87',
])('retains the exact upstream encoding for %s', async (path) => {
  await request(app)
    .get('/http/serper' + path + '?a=1&a=2&x=%252F')
    .set('Authorization', 'Bearer hub-test-token')
    .expect(200);
  expect(seen.url).toBe(path + '?a=1&a=2&x=%252F');
});

it('streams a request above 1 MiB and a response above 8 MiB without truncation', async () => {
  echoBody = true;
  upstreamHeaders = { 'Content-Type': 'application/octet-stream' };
  const bytes = Buffer.alloc(9 * 1024 * 1024, 139);
  const response = await request(app)
    .post('/http/serper/echo')
    .set('Authorization', 'Bearer hub-test-token')
    .set('Content-Type', 'application/octet-stream')
    .send(bytes)
    .expect(200);
  expect(response.body).toEqual(bytes);
});

it('preserves conditional and checksum headers while isolating caller credentials and hop headers', async () => {
  upstreamHeaders['Content-MD5'] = 'upstream-checksum';
  upstreamHeaders['X-Custom-Result'] = 'result';
  upstreamHeaders.Connection = 'X-Hop-Response';
  upstreamHeaders['X-Hop-Response'] = 'do-not-forward';
  const response = await request(app)
    .get('/http/serper/metadata')
    .set('Authorization', 'Bearer hub-test-token')
    .set('If-Match', 'revision-a')
    .set('Content-MD5', 'request-checksum')
    .set('X-Custom-Business', 'business')
    .set('X-MCPHub-Task-Id', 'task-private')
    .set('X-API-KEY', 'caller-secret')
    .set('Connection', 'X-Hop-Request')
    .set('X-Hop-Request', 'do-not-forward')
    .expect(200);
  expect(seenHeaders['if-match']).toBe('revision-a');
  expect(seenHeaders['content-md5']).toBe('request-checksum');
  expect(seenHeaders['x-custom-business']).toBe('business');
  expect(seenHeaders['x-mcphub-task-id']).toBeUndefined();
  expect(seenHeaders['x-api-key']).toBeUndefined();
  expect(seenHeaders['x-hop-request']).toBeUndefined();
  expect(response.headers['content-md5']).toBe('upstream-checksum');
  expect(response.headers['x-custom-result']).toBe('result');
  expect(response.headers['x-hop-response']).toBeUndefined();
});

it('rewrites a same-upstream redirect to this Hub resource without following it automatically', async () => {
  upstreamStatus = 307;
  upstreamHeaders.Location = '/destination?x=1';
  const response = await search();
  expect(response.status).toBe(307);
  expect(response.headers.location).toBe('/http/serper/destination?x=1');
  expect(seen.url).toBe('/serper/search?flag=1');
});

it('preserves HEAD metadata without a response body', async () => {
  upstreamHeaders['Content-Length'] = '123';
  const response = await request(app)
    .head('/http/serper/metadata')
    .set('Authorization', 'Bearer hub-test-token')
    .expect(200);
  expect(response.headers['content-length']).toBe('123');
  expect(response.text).toBeUndefined();
});

it('preserves compressed request and response bytes with their encoding and length', async () => {
  const compressed = gzipSync(Buffer.from('opaque compressed fixture'));
  echoBody = true;
  upstreamHeaders = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'gzip',
    'Content-Length': String(compressed.length),
  };
  const listener = createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  try {
    const response = await new Promise<{
      bytes: Buffer;
      headers: import('node:http').IncomingHttpHeaders;
    }>((resolve, reject) => {
      const call = httpRequest(
        {
          hostname: '127.0.0.1',
          port: (listener.address() as { port: number }).port,
          path: '/http/serper/echo',
          method: 'POST',
          headers: {
            Authorization: 'Bearer hub-test-token',
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'gzip',
            'Content-Length': String(compressed.length),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ bytes: Buffer.concat(chunks), headers: res.headers }));
          res.on('error', reject);
        },
      );
      call.on('error', reject);
      call.end(compressed);
    });
    expect(response.bytes).toEqual(compressed);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['content-length']).toBe(String(compressed.length));
    expect(seenHeaders['content-encoding']).toBe('gzip');
    expect(seenHeaders['content-length']).toBe(String(compressed.length));
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('keeps the exact configured path when no suffix is supplied, including a query', async () => {
  resource.url += '/exact-prefix';
  await request(app)
    .get('/http/serper?q=1')
    .set('Authorization', 'Bearer hub-test-token')
    .expect(200);
  expect(seen.url).toBe('/exact-prefix?q=1');
});
