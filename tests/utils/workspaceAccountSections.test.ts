import {
  workspaceAccountSections,
  loadWorkspaceAccountDefinitions,
} from '../../src/utils/workspaceAccountSections.js';

test('account declarations are fetched even when list summaries have no config', async () => {
  const names = ['toolathlon::github', 'toolathlon::fetch', 'toolathlon::sheets'];
  const { servers, failed } = await loadWorkspaceAccountDefinitions(names, async (name) => {
    if (name.endsWith('fetch'))
      return { success: false, message: 'Server has no startup account declaration' };
    return {
      success: true,
      data: {
        schema: name.endsWith('github')
          ? { values: [{ name: 'github_token' }] }
          : { files: [{ path: 'configs/google_credentials.json' }] },
      },
    };
  });
  expect(failed).toEqual([]);
  expect(workspaceAccountSections(servers, 'toolathlon')).toHaveLength(2);
});

test('metadata failures remain visible instead of silently producing an empty account', async () => {
  const { failed } = await loadWorkspaceAccountDefinitions(
    ['example::a', 'example::b'],
    async (name) => {
      if (name.endsWith('a')) throw new Error('connection failed');
      return { success: false, message: 'Forbidden' };
    },
  );
  expect(failed.sort()).toEqual(['example::a', 'example::b']);
});

test('shared Google authorization is edited once within the selected space', () => {
  const google = { enabled: true, files: [{ path: 'configs/google_credentials.json' }] };
  const sections = workspaceAccountSections(
    [
      { name: 'toolathlon::calendar', config: { workspaceSchema: google } },
      { name: 'toolathlon::sheets', config: { workspaceSchema: { ...google, http: [] } } },
      { name: 'atlas::calendar', config: { workspaceSchema: google } },
      { name: 'toolathlon::fetch' },
    ],
    'toolathlon',
    { fields: [], files: ['configs/google_credentials.json'] },
  );
  expect(sections).toHaveLength(1);
  expect(sections[0].servers).toEqual(['toolathlon::calendar', 'toolathlon::sheets']);
  expect(sections[0].configured).toBe(true);
});

test('different credentials remain independent and reflect this account only', () => {
  const sections = workspaceAccountSections(
    [
      {
        name: 'toolathlon::github',
        config: {
          workspaceSchema: {
            values: [{ name: 'github_token' }],
          },
        },
      },
      {
        name: 'toolathlon::huggingface',
        config: {
          workspaceSchema: {
            values: [{ name: 'huggingface_token' }],
          },
        },
      },
      {
        name: 'toolathlon::notion',
        config: {
          workspaceSchema: {
            files: [{ path: 'configs/.mcp-auth', directory: true }],
          },
        },
      },
    ],
    'toolathlon',
    { fields: ['github_token'], files: ['configs/.mcp-auth/token.json'] },
  );
  expect(sections.map((section) => section.configured)).toEqual([true, false, true]);
});

test('an enabled declaration supplies the editor for shared inputs', () => {
  const fields = [{ name: 'shared_token' }];
  const sections = workspaceAccountSections(
    [
      { name: 'example::a', config: { workspaceSchema: { enabled: false, values: fields } } },
      { name: 'example::b', config: { workspaceSchema: { enabled: true, values: fields } } },
    ],
    'example',
  );
  expect(sections[0].server).toBe('example::b');
  expect(sections[0].configured).toBe(false);
});

test('different environment bindings keep their per-server save paths', () => {
  const sections = workspaceAccountSections(
    [
      {
        name: 'example::a',
        config: {
          workspaceSchema: {
            values: [{ name: 'shared_token', env: 'A_TOKEN' }],
          },
        },
      },
      {
        name: 'example::b',
        config: {
          workspaceSchema: {
            values: [{ name: 'shared_token', env: 'B_TOKEN' }],
          },
        },
      },
    ],
    'example',
  );
  expect(sections).toHaveLength(2);
});
