import express from 'express';
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import axios from 'axios';
import { workspaceHttp } from '../../src/controllers/workspaceHttpController.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  workspaceManagement,
  workspaceEnabled,
  serverWorkspaceAccounts,
  createWorkspaceRun,
  workspaceAvailability,
  workspaceRun,
} from '../../src/controllers/workspaceController.js';
import { digest } from '../../src/services/workspaceService.js';
import type { StoredCredentialBinding } from '../../src/types/index.js';

const mockStore = new Map<string, StoredCredentialBinding>();
let mockGroupEnabled = true;
let mockApiStreaming = false;
let mockRequiredAccounts = false;
const mockActivity = jest.fn(async () => undefined);
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: () => ({ logToolCall: mockActivity }),
}));
jest.mock('../../src/utils/ssrf.js', () => ({
  assertSafeUrl: async () => undefined,
  ssrfConnectionOptions: () => ({}),
}));
jest.mock('../../src/services/toolCallSchedulerService.js', () => ({
  toolCallScheduler: { run: (_server: string, call: () => Promise<unknown>) => call() },
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({
    findAll: async () =>
      mockRequiredAccounts
        ? [
            {
              name: 'toolathlon::github',
              workspaceSchema: {
                enabled: true,
                values: [{ name: 'github_token', required: true }],
              },
            },
          ]
        : [],
    update: async () => ({}),
    findById: async (name: string) =>
      name === 'toolathlon::github'
        ? {
            enabled: true,
            targets: [{ kind: 'task', path: 'task/default' }],
            workspaceSchema: {
              enabled: true,
              values: [{ name: 'github_token', secret: true }],
              http: [
                {
                  id: 'api',
                  url: 'https://api.github.com',
                  streaming: mockApiStreaming,
                  credential: { value: 'github_token', header: 'Authorization', prefix: 'Bearer ' },
                },
                {
                  id: 'git',
                  url: 'https://github.com',
                  credential: {
                    value: 'github_token',
                    header: 'Authorization',
                    username: 'x-access-token',
                  },
                },
              ],
            },
          }
        : name === 'toolathlon::huggingface'
          ? {
              workspaceSchema: {
                values: [{ name: 'huggingface_token', label: 'Token' }],
                files: [
                  { path: 'configs/google_credentials.json', format: 'json' },
                  { path: 'configs/.mcp-auth', directory: true },
                ],
              },
            }
          : name === 'toolathlon::maps'
            ? {
                name,
                type: 'stdio',
                command: 'node',
                args: ['maps-v1.cjs'],
                env: { API_KEY: 'shared-key' },
                workspaceSchema: {
                  enabled: true,
                  connection: true,
                  values: [{ name: 'maps_api_key', env: 'API_KEY' }],
                },
              }
            : undefined,
  }),
  getCredentialBindingDao: () => ({
    hasBindings: async () => mockStore.size > 0,
    get: async (server: string, user: string) => mockStore.get(`${server}/${user}`) ?? null,
    listUsernames: async (server: string) =>
      [...mockStore.values()]
        .filter((value) => value.serverName === server)
        .map((value) => value.username),
    save: async (value: StoredCredentialBinding) => {
      mockStore.set(`${value.serverName}/${value.username}`, value);
    },
    delete: async (filter: { serverName: string; username: string }) => {
      mockStore.delete(`${filter.serverName}/${filter.username}`);
    },
  }),
}));
jest.mock('../../src/services/userGroupService.js', () => ({
  userGroupAllows: jest.requireActual('../../src/services/userGroupService.js').userGroupAllows,
  getUserGroupPolicy: async (_principal: unknown, key: string) => ({
    restricted: true,
    groups:
      mockGroupEnabled && key === 'key-a'
        ? [
            {
              id: 'group-a',
              servers: [
                { name: 'toolathlon::notion' },
                { name: 'toolathlon::github', targets: ['task/default'] },
              ],
            },
          ]
        : [],
  }),
}));
const app = express();
app.use((req, res, next) => (/\/http\//.test(req.path) ? next() : express.json()(req, res, next)));
app.use((req, _res, next) => {
  if (req.get('x-admin')) Object.assign(req, { user: { username: 'admin', isAdmin: true } });
  if (req.get('x-key'))
    Object.assign(req, {
      user: { username: 'admin', isAdmin: true, credentialEligible: false },
      bearerKey: { id: req.get('x-key'), userGroupId: 'group-a' },
    });
  next();
});
app.get('/api/servers/:name/accounts', serverWorkspaceAccounts);
app.get('/api/servers/:name/accounts/:account', serverWorkspaceAccounts);
app.put('/api/servers/:name/accounts/:account', serverWorkspaceAccounts);
app.get('/api/workspace-credentials', workspaceManagement);
app.put('/api/workspace-credentials/:catalog/:workspace/enabled', workspaceEnabled);
app.put('/api/workspace-credentials/:catalog/:workspace', workspaceManagement);
app.delete('/api/workspace-credentials/:catalog/:workspace', workspaceManagement);
app.get('/api/workspace-runs', workspaceAvailability);
app.post('/api/workspace-runs', createWorkspaceRun);
app.all(/^\/api\/workspace-runs\/([^/]+)\/http\/([^/]+)\/([^/]+)(\/.*)?$/, workspaceHttp);
app.get('/api/workspace-runs/:id', workspaceRun);
app.put('/api/workspace-runs/:id', workspaceRun);
app.put('/api/workspace-runs/:id/files', workspaceRun);
app.delete('/api/workspace-runs/:id', workspaceRun);
const create = (name = 'account-a') =>
  request(app)
    .put(`/api/workspace-credentials/toolathlon/${name}`)
    .set('x-admin', 'yes')
    .send({
      allowedGroupIds: ['group-a'],
      values: { github_token: 'secret-upstream' },
      files: { 'configs/google_credentials.json': '{"refresh_token":"old"}' },
    });

test('account availability is read-only, scoped and never exposes credentials or capabilities', async () => {
  await create('account-a').expect(200);
  await create('private-account')
    .send({ allowedGroupIds: ['another-group'], values: {}, files: {} })
    .expect(200);
  const status = () =>
    request(app).get('/api/workspace-runs?catalog=toolathlon').set('x-key', 'key-a');
  let response = await status().expect(200);
  expect(response.body.data.accounts).toEqual([
    {
      name: 'account-a',
      enabled: true,
      ready: true,
      missing: [],
      busy: false,
      expired: false,
      state: 'idle',
    },
  ]);
  const run = (await start().expect(200)).body.data;
  response = await status().expect(200);
  expect(response.body.data.accounts[0]).toMatchObject({ name: 'account-a', busy: true });
  expect(JSON.stringify(response.body)).not.toContain(run.token);
  expect(JSON.stringify(response.body)).not.toContain('secret-upstream');
  expect(JSON.stringify(response.body)).not.toContain('private-account');
  await access('delete', run).send({ exitReason: 'cancelled' }).expect(200);
  response = await status().expect(200);
  expect(response.body.data.accounts[0].busy).toBe(false);
  await request(app).get('/api/workspace-runs?catalog=toolathlon').expect(403);
});
const start = (name = 'account-a', key = 'key-a') =>
  request(app)
    .post('/api/workspace-runs')
    .set('x-key', key)
    .send({ catalog: 'toolathlon', workspace: name });
const access = (
  method: 'get' | 'put' | 'delete',
  run: { id: string; token: string },
  suffix = '',
  key = 'key-a',
) => {
  const agent = request(app);
  return agent[method](`/api/workspace-runs/${run.id}${suffix}`)
    .set('x-key', key)
    .set('X-MCPHub-Run-Token', run.token);
};
beforeEach(() => {
  mockStore.clear();
  mockGroupEnabled = true;
  mockRequiredAccounts = false;
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});
afterAll(() => {
  delete process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
});
test('automatic account claims are exclusive, authorized and reusable after release', async () => {
  await create('account-a').expect(200);
  await create('account-b').expect(200);
  await request(app)
    .put('/api/workspace-credentials/toolathlon/private')
    .set('x-admin', 'yes')
    .send({ allowedGroupIds: ['other'], values: {} })
    .expect(200);
  const claim = () =>
    request(app).post('/api/workspace-runs').set('x-key', 'key-a').send({ catalog: 'toolathlon' });
  const claims = await Promise.all([claim(), claim(), claim()]);
  expect(claims.map((response) => response.status).sort()).toEqual([200, 200, 409]);
  const allocated = claims
    .filter((response) => response.status === 200)
    .map((response) => response.body.data);
  expect(allocated.map((run) => run.workspace).sort()).toEqual(['account-a', 'account-b']);
  expect(allocated[0].token).not.toEqual(allocated[1].token);
  await access('delete', allocated[0]).expect(200);
  const again = await claim().expect(200);
  expect(again.body.data.workspace).toBe(allocated[0].workspace);
  await request(app)
    .post('/api/workspace-runs')
    .set('x-key', 'key-denied')
    .send({ catalog: 'toolathlon' })
    .expect(403);
});

test('HTTP preparation uses the selected run account, preserves binary Git bodies and writes redacted audit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-http-'));
  const oldAudit = process.env.MCPHUB_AUDIT_LOG_DIR;
  process.env.MCPHUB_AUDIT_LOG_DIR = directory;
  const identityRequests: unknown[] = [];
  const upstream = jest.spyOn(axios, 'request').mockImplementation(async (config: any) => {
    if (config.url === 'https://api.github.com/user') {
      identityRequests.push(config);
      return {
        status: 200,
        headers: {},
        data: Buffer.from(
          JSON.stringify({
            id: config.headers.authorization.includes('secret-account-b') ? 222 : 111,
          }),
        ),
      };
    }
    return {
      status: 201,
      data: Buffer.from('{"created":true}'),
      headers: { 'content-type': 'application/json' },
    };
  });
  try {
    await create().expect(200);
    await request(app)
      .put('/api/workspace-credentials/toolathlon/account-b')
      .set('x-admin', 'yes')
      .send({ allowedGroupIds: ['group-a'], values: { github_token: 'secret-account-b' } })
      .expect(200);
    const a = (await start().expect(200)).body.data;
    const b = (await start('account-b').expect(200)).body.data;
    const call = (run: { id: string; token: string }, token = run.token, path = 'api/user/repos') =>
      request(app)
        .post(`/api/workspace-runs/${run.id}/http/github/${path}`)
        .set('x-key', 'key-a')
        .set('X-MCPHub-Run-Token', token)
        .set('Authorization', 'Bearer hub-key')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from([0, 255, 10, 13]));
    await call(a).set('X-MCPHub-Upstream-Timeout-Ms', 'not-a-budget').expect(400);
    await call(a).set('X-MCPHub-Upstream-Timeout-Ms', '7000').expect(201);
    const business = () =>
      upstream.mock.calls.filter(([config]: any) => config.url !== 'https://api.github.com/user');
    expect(business()[0][0]).toMatchObject({
      url: 'https://api.github.com/user/repos',
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer secret-upstream' }),
      data: Buffer.from([0, 255, 10, 13]),
      timeout: 7000,
      maxRedirects: 0,
    });
    await call(b).expect(201);
    expect(business()[1][0].headers).toMatchObject({
      authorization: 'Bearer secret-account-b',
    });
    await call(a, b.token).expect(403);
    expect(business()).toHaveLength(2);
    await call(a, a.token, 'git/owner/repo.git/git-receive-pack').expect(201);
    expect(business()[2][0]).toMatchObject({
      url: 'https://github.com/owner/repo.git/git-receive-pack',
      headers: expect.objectContaining({
        authorization: 'Basic ' + Buffer.from('x-access-token:secret-upstream').toString('base64'),
      }),
    });
    mockGroupEnabled = false;
    await call(a).expect(403);
    expect(business()).toHaveLength(3);
    expect(identityRequests).toHaveLength(2);
    const audit = readdirSync(directory)
      .map((name) => readFileSync(join(directory, name), 'utf8'))
      .join('');
    expect(audit).toContain('toolathlon::github');
    // API Bearer and Git Basic authentication must aggregate under the same saved key.
    // The audited identity lookup also spends this credential once.
    expect(audit.split(digest('secret-upstream').slice(0, 16)).length - 1).toBe(6);
    for (const secret of ['secret-upstream', 'secret-account-b', 'hub-key', a.token, b.token])
      expect(audit).not.toContain(secret);
  } finally {
    upstream.mockRestore();
    if (oldAudit === undefined) delete process.env.MCPHUB_AUDIT_LOG_DIR;
    else process.env.MCPHUB_AUDIT_LOG_DIR = oldAudit;
    rmSync(directory, { recursive: true, force: true });
  }
});
test('management is write-only, encrypted and inaccessible to calling keys', async () => {
  await create().expect(200);
  const list = await request(app)
    .get('/api/workspace-credentials')
    .set('x-admin', 'yes')
    .expect(200);
  expect(list.body.data[0].fields).toEqual(['github_token']);
  expect(JSON.stringify(list.body)).not.toContain('secret-upstream');
  expect(JSON.stringify([...mockStore.values()])).not.toContain('secret-upstream');
  await request(app).get('/api/workspace-credentials').set('x-key', 'key-a').expect(403);
  await start('account-a', 'other-key').expect(403);
});
test('account API repairs PEM line escapes and rejects malformed keys before persisting', async () => {
  const pem = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  await request(app)
    .put('/api/servers/toolathlon::huggingface/accounts/account-a')
    .set('x-admin', 'yes')
    .send({
      files: {
        'configs/google_credentials.json': JSON.stringify({
          private_key: pem.replace(/\n/g, '\\n'),
          token: 'keep\\nunchanged',
        }),
      },
    })
    .expect(200);
  const account = (
    await request(app)
      .get('/api/servers/toolathlon::huggingface/accounts/account-a')
      .set('x-admin', 'yes')
      .expect(200)
  ).body.data;
  expect(JSON.parse(account.files['configs/google_credentials.json'])).toEqual({
    private_key: pem,
    token: 'keep\\nunchanged',
  });
  const bad = await request(app)
    .put('/api/servers/toolathlon::huggingface/accounts/account-a')
    .set('x-admin', 'yes')
    .send({
      revision: account.revision,
      files: {
        'configs/google_credentials.json': JSON.stringify({
          private_key:
            '-----BEGIN PRIVATE KEY-----\\nsecret-invalid-data\\n-----END PRIVATE KEY-----',
        }),
      },
    })
    .expect(400);
  expect(bad.body.message).toContain('Invalid PEM private key');
  expect(JSON.stringify(bad.body)).not.toContain('secret-invalid-data');
  const unchanged = (
    await request(app)
      .get('/api/servers/toolathlon::huggingface/accounts/account-a')
      .set('x-admin', 'yes')
      .expect(200)
  ).body.data;
  expect(unchanged).toEqual(account);
});
test('one workspace has one run; independent workspaces can run together', async () => {
  await create().expect(200);
  await create('account-b').expect(200);
  const responses = await Promise.all([start(), start()]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const run = responses.find((response) => response.status === 200)!.body.data;
  await start('account-b').expect(200);
  await create().expect(409);
  await access('get', { ...run, token: 'wrong' }).expect(403);
  await access('get', run, '', 'other-key').expect(403);
  expect((await access('get', run).expect(200)).body.data.values.github_token).toBe(
    'secret-upstream',
  );
  await access('delete', run).expect(200);
  await access('get', run).expect(403);
  await start().expect(200);
});
test('OAuth updates persist and reject stale writes, arbitrary files, and revoked groups', async () => {
  await create().expect(200);
  const run = (await start().expect(200)).body.data;
  const update = {
    path: 'configs/google_credentials.json',
    content: '{"refresh_token":"new"}',
    expectedHash: digest('{"refresh_token":"old"}'),
  };
  await access('put', run, '/files')
    .send({ updates: [update] })
    .expect(200);
  await access('put', run, '/files')
    .send({ updates: [update] })
    .expect(409);
  await access('put', run, '/files')
    .send({ updates: [{ path: 'configs/../../outside.json', content: '{}', expectedHash: null }] })
    .expect(400);
  expect((await access('get', run).expect(200)).body.data.files[update.path]).toBe(update.content);
  mockGroupEnabled = false;
  await access('get', run).expect(403);
  await access('put', run).send({}).expect(403);
});
test('updating configuration requires the latest revision and preserves blank omissions', async () => {
  await create().expect(200);
  await create().expect(409);
  const revision = (await request(app).get('/api/workspace-credentials').set('x-admin', 'yes')).body
    .data[0].revision;
  await request(app)
    .put('/api/workspace-credentials/toolathlon/account-a')
    .set('x-admin', 'yes')
    .send({ revision, allowedGroupIds: ['group-a'], values: { gcp_project_id: 'project' } })
    .expect(200);
  const run = (await start().expect(200)).body.data;
  expect((await access('get', run)).body.data.values).toEqual({
    github_token: 'secret-upstream',
    gcp_project_id: 'project',
  });
});

test('expired runs cannot silently release an account with potentially stale OAuth state', async () => {
  app.post('/api/workspace-credentials/:catalog/:workspace/release', workspaceManagement);
  await create().expect(200);
  const run = (await start().expect(200)).body.data;
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
  try {
    await access('get', run).expect(403);
    await start().expect(409);
    const availability = await request(app)
      .get('/api/workspace-runs?catalog=toolathlon')
      .set('x-key', 'key-a')
      .expect(200);
    expect(availability.body.data.accounts[0]).toMatchObject({
      name: 'account-a',
      busy: true,
      expired: true,
    });
    await request(app)
      .post('/api/workspace-credentials/toolathlon/account-a/release')
      .set('x-key', 'key-a')
      .expect(403);
    await request(app)
      .post('/api/workspace-credentials/toolathlon/account-a/release')
      .set('x-admin', 'yes')
      .send({ runId: run.id, stopped: true, authorizationReviewed: true })
      .expect(200);
    await start().expect(200);
  } finally {
    clock.mockRestore();
  }
});

test('server account editor supports A/B, preserves other MCP secrets, and limits editable fields', async () => {
  await create().expect(200);
  const endpoint = '/api/servers/toolathlon::huggingface/accounts';
  const accounts = (await request(app).get(endpoint).set('x-admin', 'yes').expect(200)).body.data
    .accounts;
  await request(app)
    .put(endpoint + '/account-a')
    .set('x-admin', 'yes')
    .send({
      revision: accounts[0].revision,
      values: { huggingface_token: 'hf-a' },
    })
    .expect(200);
  await request(app)
    .put(endpoint + '/account-b')
    .set('x-admin', 'yes')
    .send({
      values: { huggingface_token: 'hf-b' },
      allowedGroupIds: ['group-a'],
    })
    .expect(200);
  const listed = (await request(app).get(endpoint).set('x-admin', 'yes').expect(200)).body.data;
  expect(listed.accounts).toHaveLength(2);
  expect(JSON.stringify(listed)).not.toContain('hf-a');
  expect(listed.accounts.find((a: { name: string }) => a.name === 'account-a').fields).toEqual([
    'github_token',
    'huggingface_token',
  ]);
  const a = (await start().expect(200)).body.data;
  const b = (await start('account-b').expect(200)).body.data;
  expect((await access('get', a)).body.data.values).toEqual({
    github_token: 'secret-upstream',
    huggingface_token: 'hf-a',
  });
  expect((await access('get', b)).body.data.values).toEqual({ huggingface_token: 'hf-b' });
  await request(app)
    .put(endpoint + '/account-a')
    .set('x-admin', 'yes')
    .send({ values: { github_token: 'illegal' } })
    .expect(400);
  await request(app)
    .put(endpoint + '/account-c')
    .set('x-admin', 'yes')
    .send({ files: { 'configs/arbitrary.json': '{}' } })
    .expect(400);
  await request(app)
    .put(endpoint + '/account-c')
    .set('x-key', 'key-a')
    .send({ values: { huggingface_token: 'bad' } })
    .expect(403);
  await request(app)
    .put(endpoint + '/account-c')
    .set('x-admin', 'yes')
    .send({ files: { 'configs/.mcp-auth/session/tokens.json': '{}' } })
    .expect(200);
});

test('explicit account read is admin-only, no-store and limited to declared secrets', async () => {
  await create().expect(200);
  const endpoint = '/api/servers/toolathlon::huggingface/accounts/account-a';
  await request(app).get(endpoint).expect(403);
  await request(app).get(endpoint).set('x-key', 'key-a').expect(403);
  const response = await request(app).get(endpoint).set('x-admin', 'yes').expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.data.values).toEqual({}); // GitHub is not declared by this MCP.
  expect(response.body.data.files).toEqual({
    'configs/google_credentials.json': '{"refresh_token":"old"}',
  });
  await request(app)
    .get(endpoint.replace('account-a', 'missing'))
    .set('x-admin', 'yes')
    .expect(404);
  await request(app)
    .put(endpoint)
    .set('x-admin', 'yes')
    .send({ files: { 'configs/google_credentials.json': '[]' } })
    .expect(400);
});

test('account deletion requires an administrator, blocks leased accounts and preserves other accounts', async () => {
  await create().expect(200);
  await create('account-b').expect(200);
  const endpoint = '/api/workspace-credentials/toolathlon/account-a';
  await request(app).delete(endpoint).expect(403);
  await request(app).delete(endpoint).set('x-key', 'key-a').expect(403);
  const run = (await start().expect(200)).body.data;
  await request(app).delete(endpoint).set('x-admin', 'yes').expect(409);
  await access('delete', run).expect(200);
  await request(app).delete(endpoint).set('x-admin', 'yes').expect(200);
  const accounts = (
    await request(app).get('/api/workspace-credentials').set('x-admin', 'yes').expect(200)
  ).body.data;
  expect(accounts.map((account: { name: string }) => account.name)).toEqual(['account-b']);
  await start('account-a').expect(403);
  const other = (await start('account-b').expect(200)).body.data;
  expect((await access('get', other)).body.data.values.github_token).toBe('secret-upstream');
});

test('run heartbeat, sync, failure and final reason expose metadata only', async () => {
  await create().expect(200);
  const run = (await start().expect(200)).body.data;
  await access('put', run).send({ syncComplete: true }).expect(200);
  await access('put', run).send({ error: 'sync_failed' }).expect(200);
  await access('put', run).send({ error: 'token=must-not-store' }).expect(400);
  const list = () => request(app).get('/api/workspace-credentials').set('x-admin', 'yes');
  let summary = (await list()).body.data[0];
  expect(summary.run).toMatchObject({
    id: run.id,
    state: 'recovery_required',
    lastError: 'sync_failed',
  });
  expect(summary.run.lastSyncAt).toBeGreaterThan(0);
  expect(summary.run.heartbeatAt).toBeGreaterThanOrEqual(summary.run.startedAt);
  expect(JSON.stringify(summary)).not.toContain(run.token);
  expect(JSON.stringify(summary)).not.toContain('tokenHash');
  expect(JSON.stringify(summary)).not.toContain('secret-upstream');
  await access('put', run).send({ syncComplete: true }).expect(200);
  await access('delete', run).send({ exitReason: 'cancelled' }).expect(200);
  summary = (await list()).body.data[0];
  expect(summary.busy).toBe(false);
  expect(summary.run).toBeUndefined();
  expect(summary.lastRun).toMatchObject({ id: run.id, exitReason: 'cancelled', state: 'running' });
  expect(summary.lastRun.endedAt).toBeGreaterThan(0);
  await start().expect(200);
});

test('administrator recovery requires exact run and explicit stop/authorization review', async () => {
  await create().expect(200);
  const run = (await start().expect(200)).body.data;
  const url = '/api/workspace-credentials/toolathlon/account-a/release';
  await request(app)
    .post(url)
    .set('x-key', 'key-a')
    .send({ runId: run.id, stopped: true, authorizationReviewed: true })
    .expect(403);
  await request(app).post(url).set('x-admin', 'yes').send({ runId: run.id }).expect(400);
  await request(app)
    .post(url)
    .set('x-admin', 'yes')
    .send({ runId: 'different', stopped: true, authorizationReviewed: true })
    .expect(409);
  await access('get', run).expect(200);
  await request(app)
    .post(url)
    .set('x-admin', 'yes')
    .send({ runId: run.id, stopped: true, authorizationReviewed: true })
    .expect(200);
  await access('get', run).expect(403);
  const next = (await start().expect(200)).body.data;
  await request(app)
    .post(url)
    .set('x-admin', 'yes')
    .send({ runId: run.id, stopped: true, authorizationReviewed: true })
    .expect(409);
  await access('get', next).expect(200);
});

test('legacy account PEM escapes normalize on read without modifying stored authorization', async () => {
  const { encryptCredentialValues, decryptCredentialValues } = await import(
    '../../src/services/credentialBindingService.js'
  );
  const { getWorkspace } = await import('../../src/services/workspaceService.js');
  await create().expect(200);
  const stored = mockStore.get('@workspace/toolathlon/account-a')!;
  const workspace = JSON.parse((await decryptCredentialValues(stored)).payload);
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const document = JSON.stringify({
    private_key: pem.replace(/\n/g, '\\n'),
    client_email: 'account@example.test',
  });
  workspace.files['configs/gcp-service_account.keys.json'] = document;
  stored.encryptedValues = await encryptCredentialValues('@workspace', 'toolathlon/account-a', {
    payload: JSON.stringify(workspace),
  });
  const ciphertext = stored.encryptedValues;
  const exported = await getWorkspace('toolathlon', 'account-a');
  expect(JSON.parse(exported!.files['configs/gcp-service_account.keys.json']).private_key).toBe(
    pem,
  );
  expect(exported!.files['configs/google_credentials.json']).toBe('{"refresh_token":"old"}');
  expect(mockStore.get('@workspace/toolathlon/account-a')!.encryptedValues).toBe(ciphertext);
});

test('resident account launch configs share encrypted storage with task credentials and are never exposed in lists', async () => {
  await create().expect(200);
  const endpoint = '/api/servers/toolathlon::maps/accounts/account-a';
  const initial = await request(app).get(endpoint).set('x-admin', 'yes').expect(200);
  expect(initial.body.data.connection).toMatchObject({ command: 'node', args: ['maps-v1.cjs'] });
  expect(JSON.stringify(initial.body)).not.toContain('shared-key');
  await request(app)
    .put(endpoint)
    .set('x-admin', 'yes')
    .send({
      revision: initial.body.data.revision,
      values: { maps_api_key: 'maps-key-a' },
      connection: {
        type: 'stdio',
        command: 'node',
        args: ['maps-v2.cjs'],
        env: { EXTRA: 'own-config' },
      },
    })
    .expect(200);
  const saved = await request(app).get(endpoint).set('x-admin', 'yes').expect(200);
  expect(saved.body.data.connection.args).toEqual(['maps-v2.cjs']);
  expect(saved.body.data.values).toEqual({ maps_api_key: 'maps-key-a' });
  expect(saved.body.data.files).toEqual({});
  const list = await request(app)
    .get('/api/workspace-credentials')
    .set('x-admin', 'yes')
    .expect(200);
  expect(list.body.data[0].servers).toEqual(['maps']);
  expect(JSON.stringify(list.body)).not.toMatch(/maps-key-a|maps-v2|own-config/);
  expect(JSON.stringify([...mockStore.values()])).not.toMatch(/maps-key-a|maps-v2|own-config/);
  await request(app).get(endpoint).set('x-key', 'key-a').expect(403);
  await request(app)
    .put(endpoint)
    .set('x-admin', 'yes')
    .send({
      revision: saved.body.data.revision,
      connection: { type: 'stdio', command: '' },
    })
    .expect(400);
  await request(app)
    .put('/api/servers/toolathlon::github/accounts/account-a')
    .set('x-admin', 'yes')
    .send({
      revision: saved.body.data.revision,
      connection: { type: 'stdio', command: 'unexpected' },
    })
    .expect(400);
  const active = (await start().expect(200)).body.data;
  await request(app)
    .put(endpoint)
    .set('x-admin', 'yes')
    .send({
      revision: saved.body.data.revision,
      values: { maps_api_key: 'changed-during-run' },
    })
    .expect(409);
  await access('delete', active).expect(200);
});

test.each(['DELETE', 'PATCH'] as const)(
  'GitHub REST %s follows 307 with live credentials and records both hops even for streaming bindings',
  async (method) => {
    const directory = mkdtempSync(join(tmpdir(), 'github-redirect-'));
    const previous = process.env.MCPHUB_AUDIT_LOG_DIR;
    process.env.MCPHUB_AUDIT_LOG_DIR = directory;
    mockApiStreaming = true;
    const upstream = jest.spyOn(axios, 'request').mockImplementation(async (config) => {
      if (config.url === 'https://api.github.com/user')
        return { status: 200, headers: {}, data: Buffer.from('{"id":98765}') };
      expect(config.method).toBe(method);
      expect(config.headers).toMatchObject({ authorization: 'Bearer secret-upstream' });
      expect(JSON.stringify(config.headers)).not.toContain('hub-key');
      expect(config.maxRedirects).toBe(0);
      expect(config.data).toEqual(
        method === 'PATCH' ? Buffer.from('{"description":"updated"}') : Buffer.alloc(0),
      );
      if (config.url === 'https://api.github.com/repos/owner/old')
        return {
          status: 307,
          headers: { location: 'https://api.github.com/repositories/1438311668' },
          data: Buffer.from('{}'),
        };
      expect(config.url).toBe('https://api.github.com/repositories/1438311668');
      return { status: 204, headers: {}, data: Buffer.alloc(0) };
    });
    try {
      await create().expect(200);
      const run = (await start().expect(200)).body.data;
      const client = request(app);
      await client[method === 'DELETE' ? 'delete' : 'patch'](
        `/api/workspace-runs/${run.id}/http/github/api/repos/owner/old`,
      )
        .set('x-key', 'key-a')
        .set('Authorization', 'Bearer hub-key')
        .set('X-MCPHub-Run-Token', run.token)
        .set('Content-Type', 'application/json')
        .send(method === 'PATCH' ? '{"description":"updated"}' : undefined)
        .expect(204);
      const business = upstream.mock.calls.filter(
        ([config]) => config.url !== 'https://api.github.com/user',
      );
      expect(business).toHaveLength(2);
      const records = readdirSync(directory).flatMap((name) =>
        readFileSync(join(directory, name), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      );
      expect(
        records
          .filter((row) => row.event === 'upstream_finished' && row.upstream_path !== '/user')
          .map((row) => row.http_status),
      ).toEqual([307, 204]);
      expect(records.filter((row) => row.event === 'github_dispatched')).toHaveLength(2);
      expect(records.some((row) => row.event === 'github_redirect')).toBe(true);
    } finally {
      mockApiStreaming = false;
      upstream.mockRestore();
      if (previous === undefined) delete process.env.MCPHUB_AUDIT_LOG_DIR;
      else process.env.MCPHUB_AUDIT_LOG_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('draft accounts save successfully but are skipped automatically and rejected explicitly before a run is created', async () => {
  mockRequiredAccounts = true;
  await request(app)
    .put('/api/workspace-credentials/toolathlon/account-a')
    .set('x-admin', 'yes')
    .send({ allowedGroupIds: ['group-a'], values: { huggingface_token: 'draft-only-hf' } })
    .expect(200);
  await create('account-b').expect(200);
  const draft = await start('account-a').expect(422);
  expect(draft.body.message).toContain('github_token');
  expect(draft.body.message).not.toContain('draft-only-hf');
  const status = await request(app)
    .get('/api/workspace-runs?catalog=toolathlon')
    .set('x-key', 'key-a')
    .expect(200);
  expect(
    status.body.data.accounts.find((a: { name: string }) => a.name === 'account-a'),
  ).toMatchObject({ ready: false, busy: false });
  const selected = await request(app)
    .post('/api/workspace-runs')
    .set('x-key', 'key-a')
    .send({ catalog: 'toolathlon' })
    .expect(200);
  expect(selected.body.data.workspace).toBe('account-b');
  await access('delete', selected.body.data).expect(200);
});

function accountStatus(name: string, enabled: unknown, revision: unknown, admin = true) {
  const call = request(app).put(`/api/workspace-credentials/toolathlon/${name}/enabled`);
  return (admin ? call.set('x-admin', 'yes') : call.set('x-key', 'key-a')).send({
    enabled,
    revision,
  });
}
const accountSummary = async (name = 'account-a') => {
  const response = await request(app).get('/api/workspace-credentials').set('x-admin', 'yes');
  return response.body.data.find((entry: { name: string }) => entry.name === name);
};

test('disabled accounts reject explicit allocation and are skipped by automatic allocation', async () => {
  await create().expect(200);
  await create('account-b').expect(200);
  const initial = await accountSummary();
  expect(initial.enabled).toBe(true);
  await accountStatus('account-a', false, initial.revision).expect(200);
  const disabled = await accountSummary();
  expect(disabled.enabled).toBe(false);
  expect(disabled.fields).toEqual(initial.fields);
  expect(disabled.files).toEqual(initial.files);
  expect(disabled.allowedGroupIds).toEqual(initial.allowedGroupIds);
  await request(app)
    .put('/api/workspace-credentials/toolathlon/account-a')
    .set('x-admin', 'yes')
    .send({ revision: disabled.revision, allowedGroupIds: disabled.allowedGroupIds, values: {} })
    .expect(200);
  Object.assign(disabled, await accountSummary());
  expect(disabled.enabled).toBe(false);
  await request(app)
    .post('/api/workspace-runs')
    .set('x-key', 'key-a')
    .send({ catalog: 'toolathlon', workspace: 'account-a' })
    .expect(409);
  const allocated = await request(app)
    .post('/api/workspace-runs')
    .set('x-key', 'key-a')
    .send({ catalog: 'toolathlon' })
    .expect(200);
  expect(allocated.body.data.workspace).toBe('account-b');
  await access('delete', allocated.body.data).expect(200);
  await accountStatus('account-b', false, (await accountSummary('account-b')).revision).expect(200);
  await request(app)
    .post('/api/workspace-runs')
    .set('x-key', 'key-a')
    .send({ catalog: 'toolathlon' })
    .expect(409);
  await accountStatus('account-a', true, disabled.revision).expect(200);
  const enabled = (await start().expect(200)).body.data;
  expect(enabled.workspace).toBe('account-a');
});

test('disabling an occupied account preserves access, renewal, OAuth sync and release', async () => {
  await create().expect(200);
  const run = (await start().expect(200)).body.data;
  const before = await accountSummary();
  await accountStatus('account-a', false, before.revision).expect(200);
  const content = await access('get', run).expect(200);
  expect(JSON.stringify(content.body)).toContain('secret-upstream');
  await access('put', run).expect(200);
  const old = '{"refresh_token":"old"}';
  await access('put', run, '/files')
    .send({
      updates: [
        {
          path: 'configs/google_credentials.json',
          expectedHash: digest(old),
          content: '{"refresh_token":"rotated"}',
        },
      ],
    })
    .expect(200);
  await access('delete', run).expect(200);
  const after = await accountSummary();
  expect(after.enabled).toBe(false);
  await accountStatus('account-a', true, after.revision).expect(200);
  const next = (await start().expect(200)).body.data;
  const response = await access('get', next).expect(200);
  expect(JSON.stringify(response.body)).toContain('rotated');
});

test('account status requires an administrator, a boolean and the current revision', async () => {
  await create().expect(200);
  const current = await accountSummary();
  await accountStatus('account-a', false, current.revision, false).expect(403);
  await accountStatus('account-a', 'false', current.revision).expect(400);
  await accountStatus('account-a', false, 'stale').expect(409);
  await accountStatus('unknown', false, 'missing').expect(404);
  expect((await accountSummary()).enabled).toBe(true);
});
