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
