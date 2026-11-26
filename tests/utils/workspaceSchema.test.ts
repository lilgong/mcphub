import { normalizeWorkspaceSchema } from '../../src/utils/workspaceSchema.js';
import { normalizeServerConfigForPersistence } from '../../src/utils/serverConfigPersistence.js';
import { normalizeImportedServers } from '../../frontend/src/utils/jsonImport';
test('HTTP bindings reference declared secrets and fixed HTTPS origins only', () => {
  const value = {
    values: [{ name: 'github_token' }],
    http: [
      {
        id: 'api',
        url: 'https://api.github.com',
        credential: { value: 'github_token', header: 'Authorization', prefix: 'Bearer ' },
      },
    ],
  };
  expect(normalizeWorkspaceSchema(value)?.http?.[0]).toMatchObject(value.http[0]);
  for (const url of [
    'http://api.github.com',
    'https://secret@api.github.com',
    'https://api.github.com?token=secret',
  ])
    expect(() =>
      normalizeWorkspaceSchema({ ...value, http: [{ ...value.http[0], url }] }),
    ).toThrow();
  expect(() =>
    normalizeWorkspaceSchema({
      ...value,
      http: [
        {
          ...value.http[0],
          credential: {
            value: 'undeclared',
            header: 'Authorization',
          },
        },
      ],
    }),
  ).toThrow();
});
test('task JSON declares account fields without changing task routing', () => {
  const config = {
    type: 'stdio' as const,
    targets: [{ path: 'task/default', kind: 'task' as const }],
    workspaceSchema: {
      values: [{ name: 'huggingface_token', label: 'Token' }],
      files: [{ path: 'configs/.mcp-auth', directory: true }],
    },
  };
  const imported = normalizeImportedServers({ mcpServers: { 'toolathlon::huggingface': config } });
  expect(imported.issues).toEqual([]);
  const saved = normalizeServerConfigForPersistence(config);
  expect(saved.targets?.[0].kind).toBe('task');
  expect(saved.workspaceSchema?.values?.[0]).toMatchObject({
    name: 'huggingface_token',
    secret: true,
  });
  expect(imported.servers[0].config.workspaceSchema).toEqual(config.workspaceSchema);
});
test.each([
  { values: [{ name: 'token', value: 'secret-must-not-be-in-schema' }] },
  { files: [{ path: 'configs/../../outside.json' }] },
  { files: [{ path: 'configs/evil.py' }] },
  { values: [{ name: 'same' }, { name: 'same' }] },
  { files: [{ path: 'configs/.mcp-auth/../outside', directory: true }] },
])('invalid or secret-bearing metadata is rejected', (value) => {
  expect(() => normalizeWorkspaceSchema(value)).toThrow();
});

test('structured documents keep public defaults and declare visible fields', () => {
  const schema = normalizeWorkspaceSchema({
    files: [
      {
        path: 'configs/oauth.json',
        format: 'json',
        template: '{"client_secret":"","scopes":["calendar"]}',
        fields: [{ name: 'client_secret', label: 'Client Secret' }],
      },
    ],
    values: [{ name: 'warehouse', secret: false, default: 'COMPUTE_WH' }],
  });
  expect(schema?.values?.[0].default).toBe('COMPUTE_WH');
  expect(schema?.files?.[0].fields?.[0].secret).toBe(true);
});
test.each([
  {
    files: [
      {
        path: 'configs/oauth.json',
        format: 'json',
        template: '{"client_secret":"leaked"}',
        fields: [{ name: 'client_secret' }],
      },
    ],
  },
  { values: [{ name: 'token', default: 'leaked' }] },
  { files: [{ path: 'configs/oauth.json', format: 'json', template: '[]' }] },
  {
    files: [{ path: 'configs/oauth.json', format: 'json', fields: [{ name: '__proto__.secret' }] }],
  },
])('unsafe document declaration is rejected', (schema) =>
  expect(() => normalizeWorkspaceSchema(schema)).toThrow(),
);

test('managed-only task declarations preserve documentation without adding credential inputs', () => {
  const schema = normalizeWorkspaceSchema({
    managed: [
      { name: 'woocommerce_api_key', source: 'task', description: 'Provided by each task' },
      {
        name: 'snowflake_database',
        source: 'task',
        description: 'Task overrides the default',
        default: 'SNOWFLAKE',
      },
    ],
  });
  expect(schema?.values).toEqual([]);
  expect(schema?.files).toEqual([]);
  expect(schema?.enabled).toBe(false);
  expect(schema?.managed?.[1].default).toBe('SNOWFLAKE');
  expect(() =>
    normalizeWorkspaceSchema({
      managed: [{ name: 'token', source: 'task', description: '', value: 'secret' }],
    }),
  ).toThrow();
});

test('account HTTP bindings persist explicit pool egress and reject unsupported transports', () => {
  const binding = {
    id: 'api',
    url: 'https://huggingface.co',
    streaming: true,
    egress: 'ip-pool',
    credential: { value: 'token', header: 'Authorization' },
  };
  const input = { values: [{ name: 'token' }], http: [binding] };
  expect(normalizeWorkspaceSchema(input)?.http?.[0].egress).toBe('ip-pool');
  expect(() =>
    normalizeWorkspaceSchema({ ...input, http: [{ ...binding, egress: 'unknown' }] }),
  ).toThrow();
  expect(() =>
    normalizeWorkspaceSchema({
      ...input,
      http: [{ ...binding, streaming: false, protocol: 'grpc' }],
    }),
  ).toThrow();
});
