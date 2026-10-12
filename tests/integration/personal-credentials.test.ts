import {
  registerTaskConnection,
  renewTaskConnection,
} from '../../src/controllers/taskConnectionController.js';
import { connectionRuntime } from '../../src/controllers/connectionRuntimeController.js';
import {
  getUserGroups,
  getGroupResources,
  saveUserGroup,
} from '../../src/controllers/userGroupController.js';
import { getBearerKeys, createBearerKey } from '../../src/controllers/bearerKeyController.js';
import { RequestContextService } from '../../src/services/requestContextService.js';
import { logger } from '../../src/utils/logger.js';
import {
  getGroups,
  getGroup,
  createNewGroup,
  updateExistingGroup,
  getGroupShareCandidates,
} from '../../src/controllers/groupController.js';
jest.mock('openid-client', () => ({}));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Server as McpServer } from '@modelcontextprotocol/server';
import request from 'supertest';
import {
  getServerDao,
  getUserDao,
  getSystemConfigDao,
  getGroupDao,
  getBearerKeyDao,
  getBuiltinPromptDao,
  getBuiltinResourceDao,
} from '../../src/dao/DaoFactory.js';
import { auth } from '../../src/middlewares/auth.js';
import {
  sseUserContextMiddleware,
  userContextMiddleware,
} from '../../src/middlewares/userContext.js';
import {
  listMyCredentials,
  updateMyCredential,
} from '../../src/controllers/credentialBindingController.js';
import { getServerConfig, getAllServers } from '../../src/controllers/serverController.js';
import {
  handleMcpPostRequest,
  handleSseConnection,
  handleMcpOtherRequest,
  transports,
} from '../../src/services/sseService.js';
import {
  initializeClientsFromSettings,
  cleanupAllServers,
  getServersInfo,
  getServerConnectionStats,
  handleCallToolRequest,
  handleListToolsRequest,
  handleGetPromptRequest,
  handleReadResourceRequest,
} from '../../src/services/mcpService.js';
import { executeToolViaOpenAPI } from '../../src/controllers/openApiController.js';
import {
  removeServerToolEmbeddings,
  removeToolEmbeddings,
  saveToolsAsVectorEmbeddings,
} from '../../src/services/vectorSearchService.js';
import { PrincipalRuntimeService } from '../../src/services/principalRuntimeService.js';
import { UserContextService } from '../../src/services/userContextService.js';
import { createOAuthProvider } from '../../src/services/mcpOAuthProvider.js';
import { JsonFileDaoFactory, setDaoFactory } from '../../src/dao/DaoFactory.js';
import { clearSettingsCache, getNameSeparator } from '../../src/config/index.js';
import { createUserToken } from '../utils/testHelpers.js';
import {
  authenticatedRouteRateLimiter,
  mcpConnectionRateLimiter,
} from '../../src/utils/rateLimit.js';
import type { McpSettings } from '../../src/types/index.js';

jest.mock('../../src/services/oauthService.js', () => ({ initializeAllOAuthClients: jest.fn() }));
jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  removeToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn(),
  syncAllServerToolsEmbeddings: jest.fn(),
}));
jest.mock('../../src/services/mcpOAuthProvider.js', () => ({ createOAuthProvider: jest.fn() }));
const mockActivityLogToolCall = jest.fn();
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: () => ({ logToolCall: mockActivityLogToolCall }),
}));
jest.mock('../../src/services/toolResultCompressionService.js', () => ({
  maybeCompressToolResult: (result: unknown) => result,
}));
jest.mock('../../src/services/betterAuthConfig.js', () => ({
  getBetterAuthRuntimeConfig: jest.fn(async () => ({ enabled: false })),
}));

const alice = 'alice@example.com';
const bob = 'bob@example.com';
let directory: string;
let server: HttpServer;
let baseUrl: string;
let app: express.Express;
const clients: Client[] = [];
const originalEnv = {
  path: process.env.MCPHUB_SETTING_PATH,
  key: process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY,
  useDb: process.env.USE_DB,
};
const fixture = path.resolve('tests/fixtures/credential-server.mjs');
const parseIdentity = (result: any) => JSON.parse(result.content[0].text);
const apiToken = (username: string) => createUserToken(username, username === 'admin');
const bind = (username: string, value: string) =>
  request(app)
    .put('/api/credentials/shared')
    .set('x-auth-token', apiToken(username))
    .send({ username: bob, values: { 'env.PERSONAL_KEY': value } });

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-personal-e2e-'));
  process.env.MCPHUB_SETTING_PATH = path.join(directory, 'settings.json');
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.USE_DB = 'false';
  const settings: McpSettings = {
    mcpServers: {
      shared: {
        type: 'stdio',
        command: process.execPath,
        args: [fixture],
        owner: 'admin',
        visibility: 'public',
        startOnDemand: true,
        idleTimeoutMs: 200,
        env: { PERSONAL_KEY: 'org-must-never-be-used' },
        credentialTemplate: [{ target: 'env', name: 'PERSONAL_KEY' }],
      },
    },
    users: [alice, bob, 'admin'].map((username) => ({
      username,
      password: 'unused',
      isAdmin: username === 'admin',
    })),
    groups: [],
    bearerKeys: [alice, bob].map((username, index) => ({
      id: `personal-${index}`,
      name: username,
      token: `${username}-bearer`,
      kind: 'user',
      owner: username,
      enabled: true,
      accessType: 'all',
      createdAt: new Date().toISOString(),
    })),
    systemConfig: {
      routing: {
        enableGlobalRoute: true,
        enableGroupNameRoute: true,
        enableBearerAuth: true,
        skipAuth: false,
      },
      oauthServer: { enabled: false },
    },
  };
  fs.writeFileSync(process.env.MCPHUB_SETTING_PATH, JSON.stringify(settings));
  clearSettingsCache();
  JsonFileDaoFactory.getInstance().resetInstances();
  setDaoFactory(JsonFileDaoFactory.getInstance());
  await initializeClientsFromSettings(true);
  app = express();
  app.use(express.json());
  app.use('/api', authenticatedRouteRateLimiter, auth, userContextMiddleware);
  app.post('/api/tools/:serverName/:toolName', executeToolViaOpenAPI);
  app.get('/api/credentials', listMyCredentials);
  app.put('/api/credentials/:name', updateMyCredential);
  app.delete('/api/credentials/:name', updateMyCredential);
  app.get('/api/servers/:name', getServerConfig);
  app.get('/api/servers', getAllServers);
  app.post('/api/task-connections', registerTaskConnection);
  app.put('/api/task-connections/:id', renewTaskConnection);
  app.get('/api/servers/:name/runtime', connectionRuntime);
  app.get('/api/user-groups', getUserGroups);
  app.get('/api/user-groups/resources', getGroupResources);
  app.post('/api/user-groups', saveUserGroup);
  app.put('/api/user-groups/:id', saveUserGroup);
  app.delete('/api/user-groups/:id', saveUserGroup);
  app.get('/api/auth/keys', getBearerKeys);
  app.post('/api/auth/keys', createBearerKey);
  app.get('/api/groups', getGroups);
  app.get('/api/groups/:id', getGroup);
  app.post('/api/groups', createNewGroup);
  app.put('/api/groups/:id', updateExistingGroup);
  app.get('/api/groups/:id/share-candidates', getGroupShareCandidates);
  app.get('/sse/:group', mcpConnectionRateLimiter, sseUserContextMiddleware, handleSseConnection);
  app.post('/mcp/:group', mcpConnectionRateLimiter, sseUserContextMiddleware, handleMcpPostRequest);
  app.get('/mcp/:group', mcpConnectionRateLimiter, sseUserContextMiddleware, handleMcpOtherRequest);
  app.delete(
    '/mcp/:group',
    mcpConnectionRateLimiter,
    sseUserContextMiddleware,
    handleMcpOtherRequest,
  );
  server = await new Promise<HttpServer>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const client of clients) await client.close();
  for (const entry of Object.values(transports)) await entry.transport.close();
  cleanupAllServers();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries({
    MCPHUB_SETTING_PATH: originalEnv.path,
    MCPHUB_CREDENTIAL_ENCRYPTION_KEY: originalEnv.key,
    USE_DB: originalEnv.useDb,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearSettingsCache();
  JsonFileDaoFactory.getInstance().resetInstances();
});

const connect = async (username: string, serverName = 'shared') => {
  const client = new Client({ name: 'credential-e2e', version: '1' });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${serverName}`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${username}-bearer`,
          'x-personal-key': 'passthrough-must-not-win',
        },
      },
    }),
  );
  return client;
};

test('dashboard bindings are write-only, self-scoped, and preserve the shared safe view', async () => {
  expect(getServerConnectionStats()).toEqual({ total: 0, connected: 0, disconnected: 0 });
  expect((await request(app).get('/api/credentials')).status).toBe(401);
  expect((await bind(alice, 'alice-sentinel')).status).toBe(200);
  const aliceStatus = await request(app)
    .get('/api/credentials')
    .set('x-auth-token', apiToken(alice));
  expect(aliceStatus.body.data[0].configured).toBe(true);
  expect(JSON.stringify(aliceStatus.body)).not.toContain('alice-sentinel');
  const bobStatus = await request(app).get('/api/credentials').set('x-auth-token', apiToken(bob));
  expect(bobStatus.body.data[0].configured).toBe(false);
  const config = await request(app).get('/api/servers/shared').set('x-auth-token', apiToken(alice));
  expect(config.body.data.config.configRestricted).toBe(true);
  expect(config.body.data.config.credentialTemplate).toEqual([
    { target: 'env', name: 'PERSONAL_KEY' },
  ]);
  expect(JSON.stringify(config.body)).not.toContain('org-must-never-be-used');
  expect(
    (
      await request(app)
        .put('/api/credentials/shared')
        .set('Authorization', `Bearer ${alice}-bearer`)
        .send({ values: { 'env.PERSONAL_KEY': 'bad' } })
    ).status,
  ).not.toBe(200);
});

test('real stdio calls resolve bearer owners, isolate simultaneous users, and reuse a principal across sessions', async () => {
  mockActivityLogToolCall.mockClear();
  await bind(bob, 'bob-sentinel');
  const [aliceClient, bobClient, anotherAliceClient] = await Promise.all([
    connect(alice),
    connect(bob),
    connect(alice),
  ]);
  const toolLists = await Promise.all([aliceClient.listTools(), bobClient.listTools()]);
  const toolName = toolLists[0].tools[0].name;
  expect(toolLists[0].tools.map((tool) => tool.name)).toEqual([toolName]);
  const results = await Promise.all(
    [aliceClient, bobClient, anotherAliceClient].map((client) =>
      client.callTool({ name: toolName, arguments: { delay: 30 } }),
    ),
  );
  const [a, b, a2] = results.map(parseIdentity);
  expect(a.credential).toBe('alice-sentinel');
  expect(b.credential).toBe('bob-sentinel');
  expect(a2.pid).toBe(a.pid);
  expect(b.pid).not.toBe(a.pid);
  expect(a.masterKeyInherited).toBe(false);

  const activity = mockActivityLogToolCall.mock.calls
    .map(([entry]) => entry)
    .find(
      (entry) =>
        entry.server === 'shared' &&
        entry.tool === 'identity' &&
        JSON.stringify(entry.output).includes('alice-sentinel'),
    );
  expect(activity).toEqual(
    expect.objectContaining({
      hasCredentialTemplate: true,
      output: expect.objectContaining({ content: expect.any(Array) }),
    }),
  );
  expect(JSON.stringify(activity?.output)).toContain('alice-sentinel');
  const promptName = (await aliceClient.listPrompts()).prompts[0].name;
  const prompt = await aliceClient.getPrompt({ name: promptName });
  expect(JSON.parse((prompt.messages[0].content as { text: string }).text).credential).toBe(
    'alice-sentinel',
  );
  expect(
    JSON.parse(
      (await bobClient.readResource({ uri: 'personal://identity' })).contents[0].text as string,
    ).credential,
  ).toBe('bob-sentinel');
  expect((await getServersInfo()).map((info) => info.name)).toEqual(['shared']);
  expect(JSON.stringify(await getServersInfo())).not.toContain('sentinel');

  await bind(alice, 'alice-rotated');
  const rotated = parseIdentity(await aliceClient.callTool({ name: toolName }));
  expect(rotated.credential).toBe('alice-rotated');
  expect(rotated.pid).not.toBe(a.pid);
  const bobAfter = parseIdentity(await bobClient.callTool({ name: toolName }));
  expect(bobAfter.credential).toBe('bob-sentinel');
  await request(app).delete('/api/credentials/shared').set('x-auth-token', apiToken(alice));
  const missing = await aliceClient.callTool({ name: toolName });
  expect(missing.isError).toBe(true);
  expect(JSON.stringify(missing)).toContain('Credentials');
  expect(JSON.stringify(missing)).not.toContain('org-must-never-be-used');

  await getBuiltinPromptDao().create({ name: 'builtin-example', template: 'Hello' });
  await getBuiltinResourceDao().create({
    name: 'Example',
    uri: 'builtin://example',
    content: 'Hello',
  });
  const builtinResults = await UserContextService.getInstance().runWithContext(
    () =>
      Promise.all([
        handleGetPromptRequest({ params: { name: 'builtin-example' } }, { group: 'shared' }),
        handleReadResourceRequest({ params: { uri: 'builtin://example' } }, { group: 'shared' }),
      ]),
    { username: alice, password: '', isAdmin: false },
  );
  expect(builtinResults[0].messages[0].content.text).toBe('Hello');
  expect(builtinResults[1].contents[0].text).toBe('Hello');

  // Activity, including a call longer than the idle timeout, keeps a child alive.
  const slow = parseIdentity(
    await bobClient.callTool({ name: toolName, arguments: { delay: 350 } }),
  );
  const beforeIdle = parseIdentity(await bobClient.callTool({ name: toolName }));
  expect(slow.pid).toBe(beforeIdle.pid);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const afterIdle = parseIdentity(await bobClient.callTool({ name: toolName }));
  expect(afterIdle.pid).not.toBe(beforeIdle.pid);
});

test('a session/JWT principal can invoke directly, while an absent principal cannot borrow a binding', async () => {
  await bind(alice, 'literal-${PERSONAL_KEY}');
  const result = await UserContextService.getInstance().runWithContext(
    () =>
      handleCallToolRequest(
        {
          params: {
            name: 'call_tool',
            arguments: { toolName: `shared${getNameSeparator()}identity` },
          },
        },
        { server: 'shared' },
      ),
    { username: alice, password: '', isAdmin: false },
  );
  expect(result.isError).not.toBe(true);
  expect(parseIdentity(result).credential).toBe('literal-${PERSONAL_KEY}');
  const dashboard = await UserContextService.getInstance().runWithContext(
    async () => ({
      servers: await getServersInfo(),
      result: await handleCallToolRequest(
        { params: { name: 'call_tool', arguments: { toolName: 'identity' } } },
        { server: 'shared' },
      ),
    }),
    { username: alice, password: '', isAdmin: false },
  );
  expect(dashboard.servers).toHaveLength(1);
  expect(dashboard.servers[0].tools).toHaveLength(1);
  expect(dashboard.servers[0].config?.credentialTemplate).toEqual([
    { target: 'env', name: 'PERSONAL_KEY' },
  ]);
  expect(JSON.stringify(dashboard.servers)).not.toContain('literal-${PERSONAL_KEY}');
  expect(parseIdentity(dashboard.result).credential).toBe('literal-${PERSONAL_KEY}');
  const anonymous = await UserContextService.getInstance().runWithContext(() =>
    handleCallToolRequest(
      { params: { name: 'call_tool', arguments: { toolName: 'identity' } } },
      { server: 'shared', group: 'shared' },
    ),
  );
  expect(anonymous.isError).toBe(true);
  expect(JSON.stringify(anonymous)).toContain('Credentials');
});

test('HTTP and OpenAPI resolve the latest personal headers without passthrough or parameter overrides', async () => {
  app.post('/upstream', async (req, res) => {
    const upstream = new McpServer(
      { name: 'http-fixture', version: '1' },
      { capabilities: { tools: {} } },
    );
    upstream.setRequestHandler('tools/list', async () => ({
      tools: [{ name: 'identity', inputSchema: { type: 'object' } }],
    }));
    upstream.setRequestHandler('tools/call', async () => ({
      content: [
        { type: 'text', text: JSON.stringify({ credential: req.headers['x-personal-key'] }) },
      ],
    }));
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void upstream.close();
    });
    await upstream.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/api-upstream', (req, res) => {
    res.json({ credential: req.headers['x-personal-key'] });
  });
  const credentialTemplate = [{ target: 'headers' as const, name: 'X-Personal-Key' }];
  await getServerDao().create({
    name: 'httpShared',
    type: 'streamable-http',
    oauth: {},
    url: `${baseUrl}/upstream`,
    owner: 'admin',
    visibility: 'public',
    credentialTemplate,
    passthroughHeaders: ['x-personal-key'],
  });
  await getServerDao().create({
    name: 'apiShared',
    type: 'openapi',
    owner: 'admin',
    visibility: 'public',
    credentialTemplate,
    openapi: {
      schema: {
        openapi: '3.0.0',
        info: { title: 'Personal fixture', version: '1' },
        servers: [{ url: baseUrl }],
        paths: {
          '/api-upstream': {
            get: {
              operationId: 'identity',
              parameters: [{ name: 'x-personal-key', in: 'header', schema: { type: 'string' } }],
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      },
      passthroughHeaders: ['x-personal-key'],
    },
  });
  await initializeClientsFromSettings(false);
  for (const serverName of ['httpShared', 'apiShared']) {
    for (const username of [alice, bob]) {
      const saved = await request(app)
        .put(`/api/credentials/${serverName}`)
        .set('x-auth-token', apiToken(username))
        .send({ values: { 'headers.X-Personal-Key': `${username}-http` } });
      expect(saved.status).toBe(200);
    }
    const [a, b] = await Promise.all([connect(alice, serverName), connect(bob, serverName)]);
    const toolName = (await a.listTools()).tools[0].name;
    const results = await Promise.all(
      [a, b].map((client) =>
        client.callTool({
          name: toolName,
          arguments: { 'x-personal-key': 'parameter-must-not-win' },
        }),
      ),
    );
    expect(results.map(parseIdentity).map((item) => item.credential)).toEqual([
      `${alice}-http`,
      `${bob}-http`,
    ]);
    await request(app)
      .put(`/api/credentials/${serverName}`)
      .set('x-auth-token', apiToken(alice))
      .send({ values: { 'headers.X-Personal-Key': 'alice-latest' } });
    expect(parseIdentity(await a.callTool({ name: toolName })).credential).toBe('alice-latest');
  }
  expect(createOAuthProvider).not.toHaveBeenCalled();
});

test('group visibility composes with personal credentials and revokes existing MCP sessions', async () => {
  const groupDao = getGroupDao();
  const group = await groupDao.create({
    name: 'shared-team',
    owner: 'admin',
    visibility: 'group',
    sharedWithUsers: [alice],
    servers: ['shared'],
  });
  const legacy = await groupDao.create({
    name: 'legacy-team',
    owner: 'admin',
    servers: ['shared'],
  });
  await bind(alice, 'alice-group-sentinel');
  const client = await connect(alice, group.name);
  const toolName = (await client.listTools()).tools[0].name;
  expect(parseIdentity(await client.callTool({ name: toolName, arguments: {} })).credential).toBe(
    'alice-group-sentinel',
  );
  const legacyClient = await connect(bob, legacy.name);
  expect((await legacyClient.listTools()).tools).toHaveLength(1);
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'group-test', version: '1' },
    },
  };
  const denied = await request(app)
    .post('/mcp/shared-team')
    .set('Authorization', `Bearer ${bob}-bearer`)
    .set('Accept', 'application/json, text/event-stream')
    .send(initialize);
  expect(denied.status).toBe(403);
  for (const route of ['/mcp/$smart%2Fshared-team', `/mcp/${group.id}`]) {
    const response = await request(app)
      .post(route)
      .set('Authorization', `Bearer ${bob}-bearer`)
      .set('Accept', 'application/json, text/event-stream')
      .send(initialize);
    expect(response.status).toBe(403);
  }
  const sseDenied = await request(app)
    .get('/sse/shared-team')
    .set('Authorization', `Bearer ${bob}-bearer`);
  expect(sseDenied.status).toBe(403);
  await getBearerKeyDao().create({
    name: 'unrelated-scope',
    token: 'unrelated-scope-token',
    kind: 'system',
    enabled: true,
    accessType: 'groups',
    allowedGroups: ['other-team'],
    createdAt: new Date().toISOString(),
  });
  const scoped = await request(app)
    .post('/mcp/shared-team')
    .set('Authorization', 'Bearer unrelated-scope-token')
    .set('Accept', 'application/json, text/event-stream')
    .send(initialize);
  expect(scoped.status).toBe(401);
  await groupDao.update(group.id, { sharedWithUsers: [] });
  await expect(client.listTools()).rejects.toThrow(/Group access denied/);
  // Restore for SDK session cleanup.
  await groupDao.update(group.id, { sharedWithUsers: [alice] });
});

test('group APIs validate visibility, sanitize nested metadata, and keep sharing read-only', async () => {
  const created = await request(app)
    .post('/api/groups')
    .set('x-auth-token', apiToken(alice))
    .send({ name: 'new-private', servers: ['shared'] });
  expect(created.status).toBe(201);
  expect(created.body.data.visibility).toBe('private');
  const invalid = await request(app)
    .put(`/api/groups/${created.body.data.id}`)
    .set('x-auth-token', apiToken(alice))
    .send({ visibility: 'shared' });
  expect(invalid.status).toBe(400);
  await getServerDao().create({
    name: 'hidden-server',
    owner: 'admin',
    visibility: 'private',
    type: 'stdio',
    command: 'unused',
  });
  const group = await getGroupDao().create({
    name: 'metadata-team',
    owner: 'admin',
    visibility: 'public',
    servers: [
      { name: 'hidden-server', alias: 'secret-alias', tools: ['secret-tool'] },
      { name: 'shared', tools: 'all' },
    ],
  });
  const detail = await request(app)
    .get(`/api/groups/${group.id}`)
    .set('x-auth-token', apiToken(alice));
  expect(detail.body.data.servers.map((s: any) => s.name)).toEqual(['shared']);
  expect(JSON.stringify(detail.body)).not.toContain('secret');
  const listing = await request(app).get('/api/groups').set('x-auth-token', apiToken(alice));
  expect(listing.body.data.some((g: any) => g.name === 'legacy-team')).toBe(false);
  expect(JSON.stringify(listing.body)).not.toContain('secret');
  const edit = await request(app)
    .put(`/api/groups/${group.id}`)
    .set('x-auth-token', apiToken(alice))
    .send({ visibility: 'private' });
  expect(edit.status).toBe(404);
  const candidates = await request(app)
    .get(`/api/groups/${group.id}/share-candidates`)
    .set('x-auth-token', apiToken(alice));
  expect(candidates.status).toBe(404);
});

test.each([false, true])(
  'qualified dashboard calls prefer the explicit server (reverse order: %s)',
  async (reverse) => {
    const names = reverse ? ['demo-cred', 'demo'] : ['demo', 'demo-cred'];
    for (const name of names) {
      await getServerDao().create({
        name,
        type: 'stdio',
        command: process.execPath,
        args: [fixture],
        owner: 'admin',
        visibility: 'public',
        startOnDemand: true,
        ...(name === 'demo-cred'
          ? {
              credentialTemplate: [{ target: 'env' as const, name: 'PERSONAL_KEY' }],
            }
          : {}),
      });
    }
    await initializeClientsFromSettings(true);
    const acquire = jest.spyOn(PrincipalRuntimeService.prototype, 'acquire');
    try {
      const binding = await request(app)
        .put('/api/credentials/demo-cred')
        .set('x-auth-token', apiToken(alice))
        .send({ values: { 'env.PERSONAL_KEY': 'prefix-sentinel' } });
      expect(binding.status).toBe(200);
      for (const toolName of [`demo-cred${getNameSeparator()}identity`, 'identity']) {
        acquire.mockClear();
        const response = await request(app)
          .post(`/api/tools/demo-cred/${toolName}`)
          .set('x-auth-token', apiToken(alice))
          .send({});
        expect(response.status).toBe(200);
        expect(response.body.isError).not.toBe(true);
        expect(parseIdentity(response.body).credential).toBe('prefix-sentinel');
        expect(acquire.mock.calls.map(([name]) => name)).toEqual(['demo-cred']);
      }
      acquire.mockClear();
      const invalid = await request(app)
        .post('/api/tools/missing-server/demo-cred-identity')
        .set('x-auth-token', apiToken(alice))
        .send({});
      expect(invalid.status).toBe(500);
      expect(invalid.body.message).toContain('Tool not available');
      expect(acquire).not.toHaveBeenCalled();
      await request(app).delete('/api/credentials/demo-cred').set('x-auth-token', apiToken(alice));
      const missing = await request(app)
        .post('/api/tools/demo-cred/demo-cred-identity')
        .set('x-auth-token', apiToken(alice))
        .send({});
      expect(missing.body.isError).toBe(true);
      expect(JSON.stringify(missing.body)).toContain('Credentials');
    } finally {
      acquire.mockRestore();
      for (const name of names) await getServerDao().delete(name);
      await initializeClientsFromSettings(true);
    }
  },
);

test.each(['-', '__'])(
  'group calls select the longest exposed alias with separator %s',
  async (separator) => {
    const previousSeparator = getNameSeparator();
    await getSystemConfigDao().update({ nameSeparator: separator });
    clearSettingsCache();
    await bind(alice, 'alias-sentinel');
    const name = 'x';
    await getServerDao().create({
      name,
      type: 'stdio',
      command: process.execPath,
      args: [fixture],
      owner: 'admin',
      visibility: 'public',
      startOnDemand: true,
      credentialTemplate: [{ target: 'env', name: 'PERSONAL_KEY' }],
    });
    await request(app)
      .put(`/api/credentials/${name}`)
      .set('x-auth-token', apiToken(alice))
      .send({ values: { 'env.PERSONAL_KEY': 'alias-sentinel' } });
    const group = await getGroupDao().create({
      name: 'prefix-alias-team',
      owner: 'admin',
      visibility: 'public',
      servers: [
        { name: 'shared', alias: 'demo', tools: 'all' },
        { name, alias: `demo${separator}cred`, tools: 'all' },
      ],
    });
    await initializeClientsFromSettings(true);
    const acquire = jest.spyOn(PrincipalRuntimeService.prototype, 'acquire');
    try {
      await UserContextService.getInstance().runWithContext(
        () =>
          RequestContextService.getInstance().runWithCustomRequestContext(
            { headers: {}, group: group.name },
            async () => {
              const result = await handleListToolsRequest({}, { group: 'missing-group' });
              expect(result.tools.map((tool) => tool.name).sort()).toEqual(
                [`demo${separator}identity`, `demo${separator}cred${separator}identity`].sort(),
              );
            },
          ),
        { username: alice, password: '', isAdmin: false },
      );
      for (const smart of [false, true]) {
        acquire.mockClear();
        const toolName = `demo${separator}cred${separator}identity`;
        const result = await UserContextService.getInstance().runWithContext(
          () =>
            handleCallToolRequest(
              {
                params: smart ? { name: 'call_tool', arguments: { toolName } } : { name: toolName },
              },
              { group: group.name },
            ),
          { username: alice, password: '', isAdmin: false },
        );
        expect(result.isError).not.toBe(true);
        expect(parseIdentity(result).credential).toBe('alias-sentinel');
        expect(acquire.mock.calls.map(([serverName]) => serverName)).toEqual([name]);
      }
    } finally {
      acquire.mockRestore();
      await getGroupDao().delete(group.id);
      await getServerDao().delete(name);
      await getSystemConfigDao().update({ nameSeparator: previousSeparator });
      clearSettingsCache();
      await initializeClientsFromSettings(true);
    }
  },
);

test('upstream tool errors preserve diagnosis, redact personal values, and keep the runtime reusable', async () => {
  await bind(alice, 'opaque-personal-sentinel');
  const client = await connect(alice);
  const name = `shared${getNameSeparator()}identity`;
  const before = parseIdentity(await client.callTool({ name }));
  const failure = await client.callTool({ name, arguments: { fail: true } });
  expect(failure.isError).toBe(true);
  expect(JSON.stringify(failure)).toContain('Unsupported input');
  expect(JSON.stringify(failure)).toContain('callTool');
  expect(JSON.stringify(failure)).not.toContain('opaque-personal-sentinel');
  expect(JSON.stringify(failure)).not.toContain('Check your binding');
  const after = parseIdentity(await client.callTool({ name }));
  expect(after.pid).toBe(before.pid);
});

test('HTTP handshake failures survive acquisition wrappers without credential blame or secret logs', async () => {
  app.post('/unavailable-upstream', (_req, res) =>
    res.status(503).send('Temporary upstream outage; opaque-http-sentinel'),
  );
  await getServerDao().create({
    name: 'unavailableHttp',
    type: 'streamable-http',
    oauth: {},
    url: `${baseUrl}/unavailable-upstream`,
    owner: 'admin',
    visibility: 'public',
    credentialTemplate: [{ target: 'headers', name: 'X-Personal-Key' }],
  });
  await initializeClientsFromSettings(false);
  await request(app)
    .put('/api/credentials/unavailableHttp')
    .set('x-auth-token', apiToken(alice))
    .send({ values: { 'headers.X-Personal-Key': 'opaque-http-sentinel' } });
  const log = jest.spyOn(logger, 'error');
  try {
    const failure = await UserContextService.getInstance().runWithContext(
      () =>
        handleCallToolRequest(
          { params: { name: 'identity' } },
          { server: 'unavailableHttp', group: 'unavailableHttp' },
        ),
      { username: alice, password: '', isAdmin: false },
    );
    expect(failure.isError).toBe(true);
    expect(JSON.stringify(failure)).toContain('unavailableHttp');
    expect(JSON.stringify(failure)).toContain('connect');
    expect(JSON.stringify(failure)).toContain('503');
    expect(JSON.stringify(failure)).not.toMatch(
      /opaque-http-sentinel|Check your binding|Unable to resolve personal credentials/,
    );
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('opaque-http-sentinel');
  } finally {
    log.mockRestore();
  }
});

const settleUntil = async (done: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !done(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test('a per-user connect adds the tools it lists, and removes by name only the disabled ones', async () => {
  const save = jest.mocked(saveToolsAsVectorEmbeddings);
  const removeServer = jest.mocked(removeServerToolEmbeddings);
  const removeTools = jest.mocked(removeToolEmbeddings);
  const name = `shared${getNameSeparator()}identity`;
  save.mockClear();
  // A rotated binding forces a fresh per-user runtime on the next request.
  await bind(alice, 'index-sentinel');
  await (await connect(alice)).listTools();
  await settleUntil(() => save.mock.calls.length > 0);
  // One user's list is not the whole server's: add and refresh, never prune
  expect(save).toHaveBeenCalledWith('shared', [expect.objectContaining({ name })], {
    partial: true,
  });
  expect(JSON.stringify(save.mock.calls)).not.toContain('index-sentinel');

  const original = (await getServerDao().findById('shared'))?.tools ?? {};
  await getServerDao().updateTools('shared', { identity: { enabled: false } });
  try {
    save.mockClear();
    removeServer.mockClear();
    removeTools.mockClear();
    // The tools config is part of the runtime revision, so this reconnects.
    await (await connect(alice)).listTools();
    await settleUntil(() => removeTools.mock.calls.length > 0);
    expect(removeTools).toHaveBeenCalledWith('shared', [name]);
    expect(removeServer).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  } finally {
    await getServerDao().updateTools('shared', original);
  }
});

test('a user who sees fewer tools does not remove the others from the shared index', async () => {
  const save = jest.mocked(saveToolsAsVectorEmbeddings);
  const removeServer = jest.mocked(removeServerToolEmbeddings);
  const removeTools = jest.mocked(removeToolEmbeddings);
  const separator = getNameSeparator();
  const listedNames = (call: unknown[]) => (call[1] as Array<{ name: string }>).map((t) => t.name);

  // Alice's credential lists identity and rotate_identity, Bob's only identity
  await bind(alice, 'full-alice');
  save.mockClear();
  await (await connect(alice)).listTools();
  await settleUntil(() => save.mock.calls.length > 0);
  expect(listedNames(save.mock.calls[0])).toEqual([
    `shared${separator}identity`,
    `shared${separator}rotate_identity`,
  ]);

  await bind(bob, 'bob-only');
  save.mockClear();
  removeServer.mockClear();
  removeTools.mockClear();
  await (await connect(bob)).listTools();
  await settleUntil(() => save.mock.calls.length > 0);

  expect(listedNames(save.mock.calls[0])).toEqual([`shared${separator}identity`]);
  // partial: the vector store leaves rotate_identity's row alone
  expect(save.mock.calls[0][2]).toEqual({ partial: true });
  expect(removeServer).not.toHaveBeenCalled();
  expect(removeTools).not.toHaveBeenCalled();
});

test('generic static targets isolate real MCP clients and support both user and system keys without renaming tools', async () => {
  await getServerDao().create({
    name: 'target-fixture',
    type: 'streamable-http',
    enabled: true,
    owner: 'admin',
    visibility: 'public',
    targets: [
      {
        path: 'benchmark/official',
        kind: 'static',
        implementation: 'wrapper',
        version: 'wrapper-revision-1',
        allowedKeyIds: ['personal-0', 'target-system'],
        config: {
          type: 'stdio',
          command: process.execPath,
          args: [fixture],
          env: { PERSONAL_KEY: 'target-a' },
        },
      },
      {
        path: 'benchmark/synthetic',
        kind: 'static',
        implementation: 'native',
        version: 'native-2.0',
        allowedKeyIds: ['personal-1'],
        config: {
          type: 'stdio',
          command: process.execPath,
          args: [fixture],
          env: { PERSONAL_KEY: 'target-b' },
        },
      },
    ],
  });
  await getBearerKeyDao()
    .create({
      name: 'target-system',
      token: 'target-system-token',
      enabled: true,
      kind: 'system',
      accessType: 'all',
    })
    .then(async (key) => {
      // Use the generated ID in the ACL, as the dashboard does.
      const config = await getServerDao().findById('target-fixture');
      config!.targets![0].allowedKeyIds!.push(key.id);
      await getServerDao().update('target-fixture', { targets: config!.targets });
    });
  await initializeClientsFromSettings(false, 'target-fixture');
  // Fixed targets are ready before any model/client request starts.
  const ready = await getServersInfo(undefined, undefined, { username: 'admin', isAdmin: true });
  const targetRuntime = ready.find((server) => server.name === 'target-fixture')?.runtime;
  expect(targetRuntime?.running).toBe(2);
  expect(targetRuntime?.instances.every((entry) => entry.status === 'connected')).toBe(true);

  const open = async (token: string, target?: string) => {
    const client = new Client({ name: 'target-e2e', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/target-fixture`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(target ? { 'X-MCPHub-Target': target } : {}),
          },
        },
      }),
    );
    return client;
  };
  const [a, b, operator] = await Promise.all([
    open(`${alice}-bearer`, 'benchmark/official'),
    open(`${bob}-bearer`, 'benchmark/synthetic'),
    open('target-system-token', 'benchmark/official'),
  ]);
  const inventories = await Promise.all([a.listTools(), b.listTools(), operator.listTools()]);
  const name = inventories[0].tools[0].name;
  expect(inventories.every((result) => result.tools[0].name === name)).toBe(true);
  const results = await Promise.all([
    a.callTool({ name, arguments: {} }),
    b.callTool({ name, arguments: {} }),
    operator.callTool({ name, arguments: {} }),
  ]);
  expect(results.map(parseIdentity).map((value) => value.credential)).toEqual([
    'target-a',
    'target-b',
    'target-a',
  ]);
  expect(parseIdentity(results[0]).pid).not.toBe(parseIdentity(results[1]).pid);
  const adminInventory = await request(app)
    .get('/api/servers')
    .set('x-auth-token', apiToken('admin'));
  const runtime = adminInventory.body.data.find(
    (entry: { name: string }) => entry.name === 'target-fixture',
  ).runtime;
  expect(runtime.running).toBe(2);
  expect(runtime.instances).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        target: 'benchmark/official',
        implementation: 'wrapper',
        configuredVersion: 'wrapper-revision-1',
        status: 'connected',
      }),
      expect.objectContaining({
        target: 'benchmark/synthetic',
        implementation: 'native',
        configuredVersion: 'native-2.0',
        status: 'connected',
      }),
    ]),
  );
  expect(JSON.stringify(runtime)).not.toMatch(/PERSONAL_KEY|target-a|target-b|target-system-token/);
  const sharedInventory = await request(app)
    .get('/api/servers')
    .set('x-auth-token', apiToken(alice));
  expect(
    sharedInventory.body.data.find((entry: { name: string }) => entry.name === 'target-fixture'),
  ).not.toHaveProperty('runtime');
  const wrong = await open(`${alice}-bearer`, 'benchmark/synthetic');
  await expect(wrong.listTools()).rejects.toThrow();
  const missing = await open(`${alice}-bearer`);
  await expect(missing.listTools()).rejects.toThrow();
  const rest = await request(app)
    .post('/api/tools/target-fixture/identity')
    .set('x-auth-token', apiToken('admin'))
    .set('X-MCPHub-Target', 'benchmark/official')
    .send({});
  // Explicit ACL applies to dashboard administrators too.
  expect(rest.body.isError).toBe(true);
  const config = await getServerDao().findById('target-fixture');
  config!.targets![0].enabled = false;
  await getServerDao().update('target-fixture', { targets: config!.targets });
  await expect(a.listTools()).rejects.toThrow();
  // Disabling one target does not alter the other implementation's routing.
  expect(parseIdentity(await b.callTool({ name, arguments: {} })).credential).toBe('target-b');
});

test('user group keys span MCPs, select targets explicitly, and enforce live restrictions over HTTP', async () => {
  const serverDao = getServerDao();
  await serverDao.create({
    name: 'group-targeted',
    owner: 'admin',
    visibility: 'public',
    enabled: true,
    targets: ['official', 'syn-1'].map((category) => ({
      path: `atlas/${category}`,
      kind: 'static' as const,
      config: {
        type: 'stdio' as const,
        command: process.execPath,
        args: [fixture],
        env: { PERSONAL_KEY: category },
      },
    })),
  });
  await serverDao.create({
    name: 'group-ordinary',
    owner: 'admin',
    visibility: 'public',
    enabled: true,
    type: 'stdio',
    command: process.execPath,
    args: [fixture],
    env: { PERSONAL_KEY: 'ordinary' },
  });
  await serverDao.create({
    name: 'group-task',
    env: { WORKER_KEY: 'worker-fixture', PRIVATE_KEY: 'never-export' },
    owner: 'admin',
    visibility: 'public',
    enabled: true,
    targets: [
      {
        path: 'atlas/official',
        kind: 'task',
        startupEnvKeys: ['WORKER_KEY'],
        callbackOrigins: [new URL(baseUrl).origin],
      },
      { path: 'atlas/syn-1', kind: 'task' },
    ],
  });
  await initializeClientsFromSettings(true);
  const combo = await getGroupDao().create({
    name: 'group-combo',
    servers: ['group-targeted', 'group-ordinary'],
    visibility: 'public',
  });
  const body = {
    name: 'Atlas access',
    enabled: true,
    owner: 'admin',
    servers: [
      { name: 'group-targeted', targets: ['atlas/official'] },
      { name: 'group-ordinary' },
      { name: 'group-task', targets: ['atlas/official'] },
    ],
  };
  await request(app)
    .post('/api/user-groups')
    .set('x-auth-token', apiToken(alice))
    .send(body)
    .expect(400);
  await request(app)
    .post('/api/user-groups')
    .set('x-auth-token', apiToken('admin'))
    .send({ ...body, servers: [{ name: 'group-targeted', targets: ['unknown/default'] }] })
    .expect(400);
  const group = (
    await request(app)
      .post('/api/user-groups')
      .set('x-auth-token', apiToken('admin'))
      .send(body)
      .expect(201)
  ).body.data;
  const keyBody = {
    name: 'Atlas calling key',
    kind: 'system',
    accessType: 'all',
    enabled: true,
    userGroupId: group.id,
  };
  const key = (
    await request(app)
      .post('/api/auth/keys')
      .set('x-auth-token', apiToken('admin'))
      .send(keyBody)
      .expect(201)
  ).body.data;
  await request(app)
    .post('/api/auth/keys')
    .set('x-auth-token', apiToken('admin'))
    .send(keyBody)
    .expect(409);
  await request(app).get('/api/servers').set('Authorization', `Bearer ${key.token}`).expect(401);
  const storedKeys = (
    await request(app).get('/api/auth/keys').set('x-auth-token', apiToken('admin')).expect(200)
  ).body.data;
  expect(storedKeys.find((entry) => entry.id === key.id).token).not.toBe(key.token);
  const setup = (
    await request(app)
      .get('/api/servers/group-task/runtime?target=atlas/official')
      .set('Authorization', `Bearer ${key.token}`)
      .expect(200)
  ).body.data;
  expect(setup.startupEnv).toEqual({ WORKER_KEY: 'worker-fixture' });
  expect(JSON.stringify(setup)).not.toContain('never-export');
  await request(app)
    .get('/api/servers/group-task/runtime?target=atlas/syn-1')
    .set('Authorization', `Bearer ${key.token}`)
    .expect(403);
  const taskBody = {
    server: 'group-task',
    target: 'atlas/official',
    taskId: 'atlas-task',
    url: `${baseUrl}/callback`,
    token: 'callback-test',
  };
  await request(app)
    .post('/api/task-connections')
    .set('Authorization', `Bearer ${key.token}`)
    .send({ ...taskBody, url: 'http://unapproved.example/callback' })
    .expect(400);
  const lease = (
    await request(app)
      .post('/api/task-connections')
      .set('Authorization', `Bearer ${key.token}`)
      .send(taskBody)
      .expect(200)
  ).body.data;
  await request(app)
    .post('/api/task-connections')
    .set('Authorization', `Bearer ${key.token}`)
    .send({ ...taskBody, taskId: 'wrong-task', target: 'atlas/syn-1' })
    .expect(403);
  await request(app)
    .put(`/api/task-connections/${lease.id}`)
    .set('Authorization', `Bearer ${key.token}`)
    .expect(200);
  await request(app)
    .get('/api/servers/shared/runtime')
    .set('Authorization', `Bearer ${key.token}`)
    .expect(403);
  const connectKey = async (token: string, route: string, target?: string) => {
    const client = new Client({ name: 'group-access-e2e', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${route}`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(target ? { 'X-MCPHub-Target': target } : {}),
          },
        },
      }),
    );
    return client;
  };
  const client = await connectKey(key.token, combo.name, 'atlas/official');
  const tools = (await client.listTools()).tools;
  const targeted = tools.find((tool) => tool.name.startsWith('group-targeted'))!;
  const ordinary = tools.find((tool) => tool.name.startsWith('group-ordinary'))!;
  expect(targeted).toBeDefined();
  expect(ordinary).toBeDefined();
  expect(
    parseIdentity(await client.callTool({ name: targeted.name, arguments: {} })).credential,
  ).toBe('official');
  expect(
    parseIdentity(await client.callTool({ name: ordinary.name, arguments: {} })).credential,
  ).toBe('ordinary');
  await expect(connectKey(key.token, 'group-targeted', 'atlas/syn-1')).rejects.toThrow();
  await expect(connectKey(key.token, 'shared', 'atlas/official')).rejects.toThrow();
  const sharedKey = await getBearerKeyDao().create({
    name: 'common',
    token: 'group-e2e-common',
    kind: 'system',
    enabled: true,
    accessType: 'all',
  });
  const unrestricted = await connectKey(sharedKey.token, 'group-targeted', 'atlas/syn-1');
  const sharedTool = (await unrestricted.listTools()).tools[0];
  expect(
    parseIdentity(await unrestricted.callTool({ name: sharedTool.name, arguments: {} })).credential,
  ).toBe('syn-1');
  await request(app)
    .put(`/api/user-groups/${group.id}`)
    .set('x-auth-token', apiToken('admin'))
    .send({ ...body, enabled: false })
    .expect(200);
  await expect(client.callTool({ name: ordinary.name, arguments: {} })).rejects.toThrow();
  await request(app)
    .put(`/api/user-groups/${group.id}`)
    .set('x-auth-token', apiToken('admin'))
    .send(body)
    .expect(200);
  // A group edit revokes an existing session before another upstream call.
  await request(app)
    .put(`/api/user-groups/${group.id}`)
    .set('x-auth-token', apiToken('admin'))
    .send({ ...body, servers: [{ name: 'group-ordinary' }] })
    .expect(200);
  await expect(client.callTool({ name: targeted.name, arguments: {} })).rejects.toThrow();
  await request(app)
    .put(`/api/task-connections/${lease.id}`)
    .set('Authorization', `Bearer ${key.token}`)
    .expect(403);
  await request(app)
    .delete(`/api/user-groups/${group.id}`)
    .set('x-auth-token', apiToken('admin'))
    .expect(200);
  await expect(connectKey(key.token, 'group-ordinary')).rejects.toThrow();
}, 30000);

test('owned groups bind calling keys to their owner and cannot grant foreign private resources', async () => {
  const dao = getServerDao();
  for (const [name, owner, visibility] of [
    ['owned-alice', alice, 'private'],
    ['owned-bob', bob, 'private'],
    ['owned-public', 'admin', 'public'],
  ] as const) {
    await dao.create({
      name,
      owner,
      visibility,
      enabled: true,
      type: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { PERSONAL_KEY: name },
    });
  }
  await initializeClientsFromSettings(true);
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = (await getServersInfo()).find((server) => server.name === 'owned-public');
    if (info?.status === 'connected' && info.tools?.length) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const selected = (
    await request(app)
      .get('/api/user-groups/resources')
      .set('x-auth-token', apiToken(alice))
      .expect(200)
  ).body.data;
  expect(selected.some((entry: { name: string }) => entry.name === 'owned-alice')).toBe(true);
  expect(selected.some((entry: { name: string }) => entry.name === 'owned-bob')).toBe(false);
  const body = {
    name: 'Owned search',
    enabled: true,
    servers: [{ name: 'owned-alice' }, { name: 'owned-public' }],
  };
  const group = (
    await request(app)
      .post('/api/user-groups')
      .set('x-auth-token', apiToken(alice))
      .send(body)
      .expect(201)
  ).body.data;
  expect(group.owner).toBe(alice);
  expect(group).not.toHaveProperty('members');
  await request(app)
    .post('/api/user-groups')
    .set('x-auth-token', apiToken(alice))
    .send({ ...body, name: 'Escalation', servers: [{ name: 'owned-bob' }] })
    .expect(400);
  await request(app)
    .post('/api/user-groups')
    .set('x-auth-token', apiToken('admin'))
    .send({ ...body, owner: alice, name: 'Admin delegation', servers: [{ name: 'owned-bob' }] })
    .expect(400);
  await request(app)
    .put(`/api/user-groups/${group.id}`)
    .set('x-auth-token', apiToken(bob))
    .send(body)
    .expect(404);
  const key = (
    await request(app)
      .post('/api/auth/keys')
      .set('x-auth-token', apiToken(alice))
      .send({ name: 'owned key', userGroupId: group.id })
      .expect(201)
  ).body.data;
  expect(key.owner).toBe(alice);
  expect(key.kind).toBe('user');
  await request(app)
    .post('/api/auth/keys')
    .set('x-auth-token', apiToken(bob))
    .send({ name: 'foreign key', userGroupId: group.id })
    .expect(403);
  const bobGroups = (
    await request(app).get('/api/user-groups').set('x-auth-token', apiToken(bob)).expect(200)
  ).body.data;
  expect(bobGroups.some((entry: { id: string }) => entry.id === group.id)).toBe(false);
  await request(app).get('/api/users').set('Authorization', `Bearer ${key.token}`).expect(401);
  const client = new Client({ name: 'owned-group-e2e', version: '1' });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/owned-public`), {
      requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
    }),
  );
  const tool = (await client.listTools()).tools[0];
  expect(parseIdentity(await client.callTool({ name: tool.name, arguments: {} })).credential).toBe(
    'owned-public',
  );
  await dao.update('owned-public', { visibility: 'private' });
  await expect(client.callTool({ name: tool.name, arguments: {} })).rejects.toThrow();
}, 30000);
