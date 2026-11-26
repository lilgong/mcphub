import { workspaceReadiness } from '../../src/utils/workspaceReadiness.js';
import type { WorkspaceCredentials } from '../../src/types/workspace.js';

const account: WorkspaceCredentials = {
  catalog: 'bench',
  name: 'draft',
  revision: 'r',
  allowedGroupIds: [],
  values: {},
  files: {},
};
const definitions = [
  {
    name: 'bench::service',
    workspaceSchema: {
      enabled: true,
      values: [
        { name: 'key', required: true },
        { name: 'optional' },
        { name: 'role', required: true, default: 'reader' },
      ],
      files: [
        {
          path: 'configs/auth.json',
          format: 'json' as const,
          fields: [{ name: 'refresh_token', required: true }, { name: 'token' }],
        },
        { path: 'configs/key.p8', required: true },
      ],
    },
  },
];
test('draft credentials are identified without requiring optional or generated fields', () => {
  expect(workspaceReadiness(account, definitions)).toEqual({
    ready: false,
    missing: [
      'service: configs/auth.json (refresh_token)',
      'service: configs/key.p8',
      'service: key',
    ],
  });
  const complete = {
    ...account,
    values: { key: 'private-key' },
    files: {
      'configs/auth.json': '{"refresh_token":"private-refresh"}',
      'configs/key.p8': 'pem-private',
    },
  };
  expect(workspaceReadiness(complete, definitions)).toEqual({ ready: true, missing: [] });
  expect(JSON.stringify(workspaceReadiness(account, definitions))).not.toContain('private');
});
test('malformed credential documents remain drafts and unrelated namespaces/disabled schemas do not block', () => {
  expect(
    workspaceReadiness(
      { ...account, files: { 'configs/auth.json': 'incomplete json' } },
      definitions,
    ).ready,
  ).toBe(false);
  expect(
    workspaceReadiness(account, [
      { ...definitions[0], enabled: false },
      { ...definitions[0], name: 'other::service' },
      { ...definitions[0], workspaceSchema: { ...definitions[0].workspaceSchema, enabled: false } },
    ]),
  ).toEqual({ ready: true, missing: [] });
});
