import express from 'express';
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import {
  workspaceManagement,
  serverWorkspaceAccounts,
  createWorkspaceRun,
  workspaceRun,
} from '../../src/controllers/workspaceController.js';
import { digest } from '../../src/services/workspaceService.js';
import type { StoredCredentialBinding } from '../../src/types/index.js';

const mockStore = new Map<string, StoredCredentialBinding>();
let mockGroupEnabled = true;
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({
    findAll: async () => [],
    findById: async (name: string) =>
      name === 'toolathlon::huggingface'
        ? {
            workspaceSchema: {
              values: [{ name: 'huggingface_token', label: 'Token' }],
              files: [
                { path: 'configs/google_credentials.json', format: 'json' },
                { path: 'configs/.mcp-auth', directory: true },
              ],
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
  getUserGroupPolicy: async (_principal: unknown, key: string) => ({
    restricted: true,
    groups:
      mockGroupEnabled && key === 'key-a'
        ? [{ id: 'group-a', servers: [{ name: 'toolathlon::notion' }] }]
        : [],
  }),
}));
const app = express();
app.use(express.json());
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
app.put('/api/workspace-credentials/:catalog/:workspace', workspaceManagement);
app.delete('/api/workspace-credentials/:catalog/:workspace', workspaceManagement);
app.post('/api/workspace-runs', createWorkspaceRun);
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
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});
afterAll(() => {
  delete process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
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
    await request(app)
      .post('/api/workspace-credentials/toolathlon/account-a/release')
      .set('x-key', 'key-a')
      .expect(403);
    await request(app)
      .post('/api/workspace-credentials/toolathlon/account-a/release')
      .set('x-admin', 'yes')
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
