import { supportsAccountConfiguration } from '../../src/utils/accountMode.js';
import { normalizeServerConfigForPersistence } from '../../src/utils/serverConfigPersistence.js';

test('task callbacks without declared account inputs cannot open an account editor', () => {
  const targets = [{ path: 'task/default', kind: 'task' as const }];
  expect(supportsAccountConfiguration({ targets })).toBe(false);
  expect(supportsAccountConfiguration({ targets, workspaceSchema: { connection: true } })).toBe(
    false,
  );
  expect(
    supportsAccountConfiguration({
      targets,
      workspaceSchema: {
        managed: [{ name: 'task_path', source: 'task', description: 'Supplied by the task' }],
      },
    }),
  ).toBe(false);
});

test('declared task credentials and resident launch configurations remain editable', () => {
  const targets = [{ path: 'task/default', kind: 'task' as const }];
  expect(
    supportsAccountConfiguration({
      targets,
      workspaceSchema: {
        values: [{ name: 'api_key' }],
      },
    }),
  ).toBe(true);
  expect(
    supportsAccountConfiguration({
      targets,
      workspaceSchema: {
        files: [{ path: 'configs/oauth.json' }],
      },
    }),
  ).toBe(true);
  expect(supportsAccountConfiguration({ workspaceSchema: { connection: true } })).toBe(true);
});

test('a task callback cannot acquire a resident launch editor through a saved configuration', () => {
  expect(() =>
    normalizeServerConfigForPersistence({
      targets: [{ path: 'task/default', kind: 'task' }],
      workspaceSchema: { enabled: true, connection: true },
    }),
  ).toThrow('Task MCP launch configuration is owned by its benchmark adapter');
});
