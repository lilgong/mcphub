import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';

// Exercise real transports, authentication, DAOs and runtimes in an isolated subprocess.
// No production configuration, upstream accounts or fixed host ports are used.
describe('catalog runtime isolation', () => {
  let child: ChildProcess;
  let callback: HttpServer;
  let directory: string;
  let base: string;
  let dashboard: string;
  let bearer: string;
  let scoped: string;
  let output = '';
  let rpcId = 0;

  const request = async (path: string, body?: unknown, auth = dashboard, method?: string) => {
    const response = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', 'x-auth-token': auth },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() };
  };

  const rpc = async (
    path: string,
    method: string,
    params: unknown = {},
    session?: string,
    token = bearer,
    target?: string,
  ) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2025-03-26',
        ...(session ? { 'mcp-session-id': session } : {}),
        ...(target ? { 'x-mcphub-target': target } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice(6);
    return {
      status: response.status,
      body: JSON.parse(data ?? text),
      session: response.headers.get('mcp-session-id') ?? undefined,
    };
  };
  const initialize = (path: string, token = bearer, target?: string) =>
    rpc(
      path,
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'catalog-test', version: '1' },
      },
      undefined,
      token,
      target,
    );

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'mcphub-catalog-'));
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    callback = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer callback-secret') {
        res.writeHead(403).end('{}');
        return;
      }
      if (req.url?.endsWith('/list-tools')) {
        res.end(
          JSON.stringify([
            { name: 'task_identity', inputSchema: { type: 'object' } },
            { name: 'foreign_identity', inputSchema: { type: 'object' } },
            { name: 'taskonly_identity', inputSchema: { type: 'object' } },
          ]),
        );
      } else {
        res.end(JSON.stringify({ content: [{ type: 'text', text: req.url }] }));
      }
    });
    await new Promise<void>((resolve) => callback.listen(0, '127.0.0.1', resolve));
    const config = (identity: string) => ({
      type: 'stdio',
      command: process.execPath,
      args: [resolve('tests/fixtures/catalog-server.mjs')],
      env: { PERSONAL_KEY: identity },
      visibility: 'public',
      rateLimit: { enabled: true, concurrency: 1 },
    });
    writeFileSync(
      join(directory, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          arxiv: config('public'),
          'atlas::arxiv': config('atlas'),
          'toolathlon::arxiv': config('toolathlon'),
          'atlas::fixtures': {
            visibility: 'public',
            targets: [
              { path: 'fixture-a', kind: 'static', config: config('fixture-a') },
              { path: 'fixture-b', kind: 'static', config: config('fixture-b') },
            ],
          },
          'atlas::task': { targets: [{ path: 'fixture', kind: 'task' }] },
          'toolathlon::task': { targets: [{ path: 'fixture', kind: 'task' }] },
        },
        users: [],
        groups: [],
        systemConfig: { routing: { skipAuth: false } },
      }),
    );
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        NODE_ENV: 'test',
        USE_DB: 'false',
        PORT: String(port),
        MCPHUB_SETTING_PATH: join(directory, 'settings.json'),
        JWT_SECRET: 'catalog-test-secret',
        ADMIN_PASSWORD: 'Catalog-test-123!',
        MCPHUB_AUDIT_LOG_DIR: join(directory, 'audit'),
        MCP_USAGE_LOG_DIR: join(directory, 'usage'),
        MCPHUB_KEY_POOL_LOG_DIR: join(directory, 'pool'),
        MCPHUB_RELAY_LOG_FILE: join(directory, 'relay.jsonl'),
      },
    });
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        const response = await fetch(`${base}/health`);
        if (response.ok && (await response.json()).servers.connected >= 3) break;
      } catch {
        /* Startup is asynchronous. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const login = await request('/api/auth/login', {
      username: 'admin',
      password: 'Catalog-test-123!',
    });
    dashboard = login.body.token;
    expect(dashboard).toBeTruthy();
    bearer = (await request('/api/auth/keys', { name: 'all', kind: 'system', accessType: 'all' }))
      .body.data.token;
    scoped = (
      await request('/api/auth/keys', {
        name: 'atlas-only',
        kind: 'system',
        accessType: 'servers',
        allowedServers: ['atlas::arxiv'],
      })
    ).body.data.token;
  }, 60000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (callback) await new Promise<void>((resolve) => callback.close(() => resolve()));
    if (directory) rmSync(directory, { recursive: true, force: true });
  }, 15000);

  it('creates and renames within a catalog without changing another namespace', async () => {
    const config = { type: 'streamable-http', url: 'http://127.0.0.1:1/mcp', enabled: false };
    expect(
      (await request('/api/servers', { catalog: 'atlas', name: 'managed', config })).status,
    ).toBe(200);
    expect(
      (await request('/api/servers', { catalog: 'toolathlon', name: 'managed', config })).status,
    ).toBe(200);
    expect(
      (await request('/api/servers', { catalog: 'atlas', name: 'managed', config })).status,
    ).toBe(400);
    expect(
      (
        await request(
          '/api/servers/atlas%3A%3Amanaged',
          { newName: 'renamed', config },
          dashboard,
          'PUT',
        )
      ).status,
    ).toBe(200);
    expect((await request('/api/servers/atlas%3A%3Arenamed')).status).toBe(200);
    expect((await request('/api/servers/toolathlon%3A%3Amanaged')).status).toBe(200);
    const catalogs = await request('/api/catalogs');
    expect(catalogs.body.data.map((entry: { name: string }) => entry.name)).toEqual([
      '',
      'atlas',
      'toolathlon',
    ]);
    await request('/api/servers/atlas%3A%3Arenamed', undefined, dashboard, 'DELETE');
    await request('/api/servers/toolathlon%3A%3Amanaged', undefined, dashboard, 'DELETE');
  });

  it('retains the same external tool names and routes to separate upstreams', async () => {
    for (const catalog of ['', 'atlas', 'toolathlon']) {
      const path = `/mcp/${catalog ? catalog + '/' : ''}arxiv`;
      const init = await initialize(path);
      expect(init.status).toBe(200);
      const tools = await rpc(path, 'tools/list', {}, init.session);
      expect(tools.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'arxiv-identity',
      ]);
      const call = await rpc(
        path,
        'tools/call',
        { name: 'arxiv-identity', arguments: {} },
        init.session,
      );
      expect(JSON.parse(call.body.result.content[0].text).credential).toBe(catalog || 'public');
    }
  });

  it('excludes catalog tools, prompts and resources from the public aggregate', async () => {
    const { session } = await initialize('/mcp');
    const tools = await rpc('/mcp', 'tools/list', {}, session);
    expect(tools.body.result.tools).toHaveLength(1);
    expect((await rpc('/mcp', 'prompts/list', {}, session)).body.result.prompts).toHaveLength(1);
    expect((await rpc('/mcp', 'resources/list', {}, session)).body.result.resources).toHaveLength(
      1,
    );
    const guessed = await rpc(
      '/mcp',
      'tools/call',
      { name: 'atlas::arxiv-identity', arguments: {} },
      session,
    );
    expect(guessed.body.result.isError).toBe(true);
  });

  it('rejects cross-catalog sessions, internal aliases and missing namespace routes', async () => {
    const { session } = await initialize('/mcp/atlas/arxiv');
    expect((await rpc('/mcp/toolathlon/arxiv', 'tools/list', {}, session)).status).toBe(403);
    for (const path of ['/mcp/atlas::arxiv', '/mcp/missing/arxiv', '/mcp/atlas/arxiv/extra']) {
      expect((await initialize(path)).status).toBe(404);
    }
  });

  it('checks existing bearer grants against the scoped MCP identity', async () => {
    expect((await initialize('/mcp/atlas/arxiv', scoped)).status).toBe(200);
    expect((await initialize('/mcp/toolathlon/arxiv', scoped)).status).toBe(401);
    expect((await initialize('/mcp/arxiv', scoped)).status).toBe(401);
  });

  it('serializes a catalog queue without consuming the other catalog queue', async () => {
    const atlas = await initialize('/mcp/atlas/arxiv');
    const toolathlon = await initialize('/mcp/toolathlon/arxiv');
    const invoke = async (catalog: string, session?: string) => {
      const result = await rpc(
        `/mcp/${catalog}/arxiv`,
        'tools/call',
        {
          name: 'arxiv-identity',
          arguments: { delay: 200 },
        },
        session,
      );
      return JSON.parse(result.body.result.content[0].text);
    };
    const sequential = await Promise.all([
      invoke('atlas', atlas.session),
      invoke('atlas', atlas.session),
    ]);
    sequential.sort((a, b) => a.startedAt - b.startedAt);
    expect(sequential[1].startedAt).toBeGreaterThanOrEqual(sequential[0].finishedAt);
    const independent = await Promise.all([
      invoke('atlas', atlas.session),
      invoke('toolathlon', toolathlon.session),
    ]);
    expect(Math.max(...independent.map((call) => call.startedAt))).toBeLessThan(
      Math.min(...independent.map((call) => call.finishedAt)),
    );
  });

  it('keeps fixture target selection inside the chosen catalog', async () => {
    for (const target of ['fixture-a', 'fixture-b']) {
      const path = '/mcp/atlas/fixtures';
      const init = await initialize(path, bearer, target);
      const tools = await rpc(path, 'tools/list', {}, init.session, bearer, target);
      const call = await rpc(
        path,
        'tools/call',
        {
          name: tools.body.result.tools[0].name,
          arguments: {},
        },
        init.session,
        bearer,
        target,
      );
      expect(JSON.parse(call.body.result.content[0].text).credential).toBe(target);
    }
  });

  it('registers task callbacks under distinct catalog identities without renaming tools', async () => {
    const port = (callback.address() as { port: number }).port;
    for (const catalog of ['atlas', 'toolathlon']) {
      const result = await request('/api/task-connections', {
        catalog,
        server: 'task',
        target: 'fixture',
        taskId: 'same-task',
        url: `http://127.0.0.1:${port}/${catalog}`,
        token: 'callback-secret',
      });
      expect(result.status).toBe(200);
      const { path, token } = result.body.data;
      const list = await fetch(`${base}${path}/list-tools`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(await list.json()).toEqual([
        { name: 'task_identity', inputSchema: { type: 'object' } },
      ]);
      const called = await fetch(`${base}${path}/call-tool`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool_name: 'task_identity', tool_args: {} }),
      });
      expect((await called.json()).content[0].text).toBe(`/${catalog}/call-tool`);
    }
  });
  it('routes task-only connections by task ID without a fixture and filters startup secrets', async () => {
    const created = await request('/api/servers', {
      catalog: 'atlas',
      name: 'taskonly',
      config: {
        env: { TASK_KEY: 'base', UNRELATED_SECRET: 'never-delegate' },
        targets: [
          {
            path: 'task/default',
            kind: 'task',
            startupEnvKeys: ['TASK_KEY'],
            config: { env: { TASK_KEY: 'explicit-target-value' } },
          },
        ],
      },
    });
    expect(created.status).toBe(200);
    const runtime = await request('/api/servers/taskonly/runtime?catalog=atlas');
    expect(runtime.status).toBe(200);
    expect(runtime.body.data.startupEnv).toEqual({ TASK_KEY: 'base' });
    expect(JSON.stringify(runtime.body)).not.toContain('never-delegate');
    const port = (callback.address() as { port: number }).port;
    const leases: { path: string; token: string }[] = [];
    for (const taskId of ['alpha', 'beta']) {
      const registered = await request('/api/task-connections', {
        catalog: 'atlas',
        server: 'taskonly',
        taskId,
        url: `http://127.0.0.1:${port}/${taskId}`,
        token: 'callback-secret',
      });
      expect(registered.status).toBe(200);
      leases.push(registered.body.data);
    }
    const wrong = await fetch(`${base}${leases[1].path}/list-tools`, {
      method: 'POST',
      headers: { authorization: `Bearer ${leases[0].token}` },
    });
    expect(wrong.status).toBe(403);
    for (const [index, lease] of leases.entries()) {
      const called = await fetch(`${base}${lease.path}/call-tool`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool_name: 'taskonly_identity', tool_args: {} }),
      });
      expect(called.status).toBe(200);
      expect((await called.json()).content[0].text).toBe(
        `/${index === 0 ? 'alpha' : 'beta'}/call-tool`,
      );
    }
  });
  it('keeps real child cache files separate across catalogs and account targets', async () => {
    const created: string[] = [];
    const cacheFiles = new Set<string>();
    try {
      for (const catalog of ['atlas', 'toolathlon']) {
        const response = await request('/api/servers', {
          catalog,
          name: 'cacheprobe',
          config: {
            visibility: 'public',
            targets: ['official', 'fixture3'].map((target) => ({
              path: target,
              kind: 'static',
              config: {
                type: 'stdio',
                command: process.execPath,
                args: [resolve('tests/fixtures/catalog-server.mjs')],
                env: {
                  // Identical credentials cannot erase namespace/target isolation.
                  SLACK_MCP_XOXP_TOKEN: 'synthetic-shared-test-token',
                  PERSONAL_KEY: `${catalog}/${target}`,
                  CATALOG_TEST_CACHE_PROBE: 'true',
                },
              },
            })),
          },
        });
        expect(response.status).toBe(200);
        created.push(`${catalog}::cacheprobe`);
      }
      for (const catalog of ['atlas', 'toolathlon']) {
        for (const target of ['official', 'fixture3']) {
          const path = `/mcp/${catalog}/cacheprobe`;
          const init = await initialize(path, bearer, target);
          expect(init.status).toBe(200);
          const result = await rpc(
            path,
            'tools/call',
            { name: 'cacheprobe-identity', arguments: {} },
            init.session,
            bearer,
            target,
          );
          expect(result.body.result.isError).not.toBe(true);
          const identity = JSON.parse(result.body.result.content[0].text);
          expect(identity.cachedCredentials).toEqual([
            `${catalog}/${target}`,
            `${catalog}/${target}`,
          ]);
          for (const file of identity.cacheFiles) cacheFiles.add(file);
        }
      }
      expect(cacheFiles.size).toBe(8);
    } finally {
      for (const key of created)
        await request(`/api/servers/${encodeURIComponent(key)}`, undefined, dashboard, 'DELETE');
    }
  });

  it('keeps deleted namespaces selectable only in log history', async () => {
    const created = await request('/api/servers', {
      catalog: 'retired',
      name: 'arxiv',
      config: {
        type: 'stdio',
        command: process.execPath,
        args: [resolve('tests/fixtures/catalog-server.mjs')],
        env: { PERSONAL_KEY: 'retired-fixture' },
        visibility: 'public',
      },
    });
    expect(created.status).toBe(200);
    // Cache discovery before this namespace has any completed calls.
    expect((await request('/api/logs/catalogs')).status).toBe(200);
    const path = '/mcp/retired/arxiv';
    const session = await initialize(path);
    expect(session.status).toBe(200);
    const call = await rpc(
      path,
      'tools/call',
      { name: 'arxiv-identity', arguments: {} },
      session.session,
    );
    expect(call.status).toBe(200);
    expect(
      (await request('/api/servers/retired%3A%3Aarxiv', undefined, dashboard, 'DELETE')).status,
    ).toBe(200);
    const current = await request('/api/catalogs');
    expect(current.body.data.map((item: { name: string }) => item.name)).not.toContain('retired');
    const history = await request('/api/logs/catalogs');
    expect(history.status).toBe(200);
    expect(history.body.data.map((item: { name: string }) => item.name)).toContain('retired');
    const statistics = await request('/api/logs/statistics?catalog=retired');
    expect(statistics.body.data.total).toBe(1);
  });
});
