import { selectWorkspaceMaterial } from '../../src/utils/workspaceMaterial.js';
import type { WorkspaceCredentials } from '../../src/types/workspace.js';
const workspace: WorkspaceCredentials = {
  catalog: 'example',
  name: 'account-a',
  allowedGroupIds: [],
  revision: 'r',
  values: { hf_token: 'saved-hf', common: 'settings' },
  files: { 'configs/google_credentials.json': 'google', 'configs/ports_config.yaml': 'ports' },
};
test('startup accounts are opt-in; disabled fields remain stored but are not exported', () => {
  const schemas = [
    { values: [{ name: 'hf_token' }], files: [{ path: 'configs/google_credentials.json' }] },
  ];
  expect(selectWorkspaceMaterial(workspace, schemas)).toEqual({
    values: { common: 'settings' },
    files: { 'configs/ports_config.yaml': 'ports' },
  });
  expect(workspace.values.hf_token).toBe('saved-hf');
  expect(
    selectWorkspaceMaterial(
      workspace,
      schemas.map((schema) => ({ ...schema, enabled: true })),
    ),
  ).toEqual({ values: workspace.values, files: workspace.files });
});
test('a shared authorization remains available when another MCP enables it', () => {
  const file = { path: 'configs/google_credentials.json' };
  expect(
    selectWorkspaceMaterial(workspace, [
      { enabled: false, files: [file] },
      { enabled: true, files: [file] },
    ]).files,
  ).toEqual(workspace.files);
});
test('registrations without account declarations retain existing behavior', () => {
  expect(selectWorkspaceMaterial(workspace, [])).toEqual({
    values: workspace.values,
    files: workspace.files,
  });
});
