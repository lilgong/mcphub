import express from 'express';
import request from 'supertest';
import {
  registerTaskConnection,
  renewTaskConnection,
  removeTaskConnection,
  dispatchTaskConnection,
} from '../../src/controllers/taskConnectionController.js';
import { taskConnections } from '../../src/services/taskConnectionService.js';
import type { ServerConfig } from '../../src/types/index.js';
const mockActivity = jest.fn(async () => undefined);
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: () => ({ logToolCall: mockActivity }),
}));
let mockDefinition: ServerConfig;
let mockEnabledKey = true;
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getSystemConfigDao: () => ({ get: async () => ({}) }),
  getServerDao: () => ({ findById: async () => mockDefinition }),
  getBearerKeyDao: () => ({
    findById: async () => ({ enabled: mockEnabledKey, kind: 'system', accessType: 'all' }),
  }),
}));
jest.mock('../../src/utils/ssrf.js', () => ({ assertSafeUrl: async () => undefined }));
jest.mock('../../src/services/toolCallSchedulerService.js', () => ({
  toolCallScheduler: { run: (_name: string, call: () => Promise<unknown>) => call() },
}));
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (req.get('x-test-admin'))
    Object.assign(req, {
      user: { username: 'operator', isAdmin: true },
      bearerKey: { id: req.get('x-test-admin') },
    });
  next();
});
app.post('/api/task-connections', registerTaskConnection);
app.put('/api/task-connections/:id', renewTaskConnection);
app.delete('/api/task-connections/:id', removeTaskConnection);
app.post('/gateway/v1/tasks/:id/:operation', dispatchTaskConnection);
const register = (taskId: string, key = 'caller-a') =>
  request(app)
    .post('/api/task-connections')
    .set('x-test-admin', key)
    .set('X-MCPHub-Benchmark', 'another-benchmark')
    .send({
      server: 'filesystem',
      target: 'project/official',
      taskId,
      url: `http://callback/${taskId}`,
      token: 'upstream-test-token',
    });
beforeEach(() => {
  mockActivity.mockClear();
  mockEnabledKey = true;
  mockDefinition = {
    enabled: true,
    targets: [{ path: 'project/official', kind: 'task', allowedKeyIds: ['caller-a'] }],
  };
});
afterEach(() => jest.restoreAllMocks());
test('task exceptions retain original MCP details and are audited as tool errors', async () => {
  const result = {
    content: [{ type: 'text', text: 'MCP error -32603: No output' }],
    isError: true,
    _meta: {
      'mcphub/taskException': { kind: 'mcp', error: { code: -32603, message: 'No output' } },
    },
  };
  jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
  const entry = (await register('exception-details').expect(200)).body.data;
  try {
    const response = await request(app)
      .post(`${entry.path}/call-tool`)
      .set('Authorization', `Bearer ${entry.token}`)
      .send({ tool_name: 'filesystem_read_file', tool_args: {} })
      .expect(200);
    expect(response.body).toEqual(result);
    expect(mockActivity).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  } finally {
    taskConnections.remove(entry.id, 'caller-a');
  }
});
test('registration requires operator and exact target permission; no implicit target', async () => {
  await request(app).post('/api/task-connections').send({}).expect(403);
  await register('unauthorized', 'caller-b').expect(403);
  await request(app)
    .post('/api/task-connections')
    .set('x-test-admin', 'caller-a')
    .send({ server: 'filesystem', taskId: 'missing', url: 'http://callback', token: 'x' })
    .expect(400);
});
test('disabled task targets reject registration and forwarding of existing leases', async () => {
  const entry = (await register('disable-target').expect(200)).body.data;
  mockDefinition.targets![0].enabled = false;
  await register('disabled-new').expect(403);
  const fetch = jest.spyOn(global, 'fetch');
  await request(app)
    .post(`${entry.path}/list-tools`)
    .set('Authorization', `Bearer ${entry.token}`)
    .send({})
    .expect(502);
  expect(fetch).not.toHaveBeenCalled();
  taskConnections.remove(entry.id, 'caller-a');
});
test('task capabilities route only to their registered clients and never survive teardown or key revocation', async () => {
  const fetch = jest.spyOn(global, 'fetch').mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: String(url).includes('/task-a/') ? 'A' : 'B' }],
          isError: false,
        }),
        { status: 200 },
      ),
  );
  const a = (await register('task-a').expect(200)).body.data;
  const b = (await register('task-b').expect(200)).body.data;
  const call = (entry: { path: string; token: string }, token = entry.token) =>
    request(app)
      .post(`${entry.path}/call-tool`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tool_name: 'filesystem_read_file', tool_args: {} });
  await call(a, b.token).expect(403);
  expect(fetch).not.toHaveBeenCalled();
  expect((await call(a).expect(200)).body.content[0].text).toBe('A');
  expect((await call(b).expect(200)).body.content[0].text).toBe('B');
  expect(mockActivity).toHaveBeenCalledTimes(2);
  expect(mockActivity).toHaveBeenCalledWith(
    expect.objectContaining({
      server: 'filesystem',
      status: 'success',
      hasCredentialTemplate: true,
    }),
  );
  await request(app)
    .delete(`/api/task-connections/${a.id}`)
    .set('x-test-admin', 'caller-b')
    .expect(404);
  await request(app)
    .delete(`/api/task-connections/${a.id}`)
    .set('x-test-admin', 'caller-a')
    .expect(200);
  await call(a).expect(403);
  mockEnabledKey = false;
  await call(b).expect(502);
  expect(fetch).toHaveBeenCalledTimes(2);
  taskConnections.remove(b.id, 'caller-a');
});
test('leases expire, targets removed from configuration reject forwarding', async () => {
  const a = (await register('removed').expect(200)).body.data;
  mockDefinition.targets = [];
  await request(app)
    .post(`${a.path}/list-tools`)
    .set('Authorization', `Bearer ${a.token}`)
    .send({})
    .expect(502);
  taskConnections.remove(a.id, 'caller-a');
  const expired = taskConnections.register(
    {
      server: 's',
      taskId: 't',
      target: 'p/s',
      owner: 'owner',
      username: 'operator',
      url: 'http://x',
      upstreamToken: 't',
    },
    -1,
  );
  expect(taskConnections.acquire(expired.id, expired.token)).toBeUndefined();
});

test('task-only MCPs register without fixture selectors and retain task authorization', async () => {
  mockDefinition.targets = [{ path: 'task/default', kind: 'task', allowedKeyIds: ['caller-a'] }];
  const body = {
    server: 'filesystem',
    taskId: 'targetless-a',
    url: 'http://callback/targetless',
    token: 'upstream-test-token',
  };
  await request(app)
    .post('/api/task-connections')
    .set('x-test-admin', 'caller-b')
    .send(body)
    .expect(403);
  const a = await request(app)
    .post('/api/task-connections')
    .set('x-test-admin', 'caller-a')
    .send(body)
    .expect(200);
  const b = await request(app)
    .post('/api/task-connections')
    .set('x-test-admin', 'caller-a')
    .send({ ...body, taskId: 'targetless-b' })
    .expect(200);
  expect(a.body.data.id).not.toBe(b.body.data.id);
  expect(a.body.data.token).not.toBe(b.body.data.token);
  await request(app)
    .post('/api/task-connections')
    .set('x-test-admin', 'caller-a')
    .send(body)
    .expect(400);
});

test('task response caps can be configured or explicitly deferred to the trusted worker', async () => {
  mockDefinition.targets![0].config = { options: { timeout: 0, maxBufferSize: 16 } };
  const entry = (await register('response-budget').expect(200)).body.data;
  jest
    .spyOn(global, 'fetch')
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'original-result' }] })),
    );
  try {
    await request(app)
      .post(`${entry.path}/call-tool`)
      .set('Authorization', `Bearer ${entry.token}`)
      .send({ tool_name: 'filesystem_read', tool_args: {} })
      .expect(502);
    mockDefinition.targets![0].config!.options!.maxBufferSize = 0;
    const response = await request(app)
      .post(`${entry.path}/call-tool`)
      .set('Authorization', `Bearer ${entry.token}`)
      .send({ tool_name: 'filesystem_read', tool_args: {} })
      .expect(200);
    expect(response.body.content[0].text).toBe('original-result');
  } finally {
    taskConnections.remove(entry.id, 'caller-a');
  }
});
