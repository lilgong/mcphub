import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeImportedServers } from '../../frontend/src/utils/jsonImport';

describe('normalizeImportedServers', () => {
  it('preserves stdio timeout options during JSON import', () => {
    const { servers, issues } = normalizeImportedServers({
      mcpServers: {
        'my-server': {
          command: 'npx',
          args: ['-y', 'some-mcp-server'],
          options: {
            timeout: 120000,
            resetTimeoutOnProgress: true,
            maxTotalTimeout: 240000,
          },
        },
      },
    });

    expect(issues).toEqual([]);
    expect(servers).toEqual([
      {
        name: 'my-server',
        config: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'some-mcp-server'],
          options: {
            timeout: 120000,
            resetTimeoutOnProgress: true,
            maxTotalTimeout: 240000,
          },
        },
      },
    ]);
  });
});

it('accepts the distributable HTTP forwarding template without losing URL or timeout', () => {
  const config = JSON.parse(
    readFileSync(join(__dirname, '../../examples/http-forwarding/serper.json'), 'utf8'),
  );
  const { servers, issues } = normalizeImportedServers(config);
  expect(issues).toEqual([]);
  expect(servers[0].config).toMatchObject({
    type: 'http-proxy',
    url: 'https://yibuapi.com/serper',
    headers: { Authorization: '' },
    options: { timeout: 60000 },
  });
});

it('scopes plain names without dropping target and relay configuration', () => {
  const config = {
    command: 'node',
    enabled: false,
    targets: [{ id: 'fixture-a', enabled: true, command: 'node', args: ['fixture.mjs'] }],
    relay: { enabled: true, upstream: 'arxiv' },
  };
  const { servers, issues } = normalizeImportedServers(
    { mcpServers: { arxiv: config } } as any,
    'atlas',
  );
  expect(issues).toEqual([]);
  expect(servers[0]).toMatchObject({ name: 'atlas::arxiv', config });
});

it('preserves exported namespaces and rejects a conflicting destination', () => {
  const input = { mcpServers: { 'atlas::arxiv': { command: 'node' } } };
  expect(normalizeImportedServers(input, '').servers[0].name).toBe('atlas::arxiv');
  expect(normalizeImportedServers(input, 'toolathlon')).toMatchObject({
    servers: [],
    issues: [{ name: 'atlas::arxiv', message: expect.stringContaining('atlas') }],
  });
});

it('reports duplicate destinations when plain and scoped names converge', () => {
  const input = { mcpServers: { arxiv: { command: 'node' }, 'atlas::arxiv': { command: 'node' } } };
  const result = normalizeImportedServers(input, 'atlas');
  expect(result.servers).toHaveLength(1);
  expect(result.issues[0].message).toContain('Duplicate destination');
});

it('rejects invalid namespace names before importing servers', () => {
  const result = normalizeImportedServers(
    { mcpServers: { arxiv: { command: 'node' } } },
    '../atlas',
  );
  expect(result.servers).toEqual([]);
  expect(result.issues).toHaveLength(1);
});

it('imports task-only definitions without inventing a local executable', () => {
  const config = {
    targets: [{ path: 'task/default', kind: 'task' as const, config: { options: { timeout: 0 } } }],
  };
  const result = normalizeImportedServers({ mcpServers: { notion: config } }, 'toolathlon');
  expect(result.issues).toEqual([]);
  expect(result.servers[0]).toMatchObject({ name: 'toolathlon::notion', config });
  expect(result.servers[0].config.command).toBeUndefined();
});
