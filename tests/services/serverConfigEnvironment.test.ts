import {
  getServerEnvironment,
  expandServerConfig,
} from '../../src/services/serverConfigEnvironment.js';

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: () => ({
    findByUsername: async (username: string) =>
      username === 'admin' ? { isAdmin: true } : username === 'member' ? { isAdmin: false } : null,
  }),
}));

describe('server configuration environment boundary', () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original, HUB_SECRET: 'synthetic-hub-secret' };
  });
  afterAll(() => {
    process.env = original;
  });

  it.each(['member', 'deleted-user'])('does not expose process secrets for %s', async (owner) => {
    const config = {
      owner,
      url: 'https://example.com/${HUB_SECRET}',
      env: { COPIED: '${HUB_SECRET}', OWN: 'user-value' },
      headers: { Leak: '${HUB_SECRET}', Indirect: '${COPIED}', Own: '${OWN}' },
    };
    const expanded = await expandServerConfig(config);
    const env = await getServerEnvironment(config);
    expect(JSON.stringify(expanded)).not.toContain('synthetic-hub-secret');
    expect(env.HUB_SECRET).toBeUndefined();
    expect(expanded.headers.Own).toBe('user-value');
  });

  it('preserves authorization fields as literal values', async () => {
    const config = {
      owner: '${ROLE}',
      visibility: 'group' as const,
      sharedWithUsers: ['${ROLE}'],
      env: { ROLE: 'admin', DOLLAR: '$' },
      headers: { Leak: '${DOLLAR}{HUB_SECRET}' },
    };
    const expanded = await expandServerConfig(config);
    expect(expanded.owner).toBe(config.owner);
    expect(expanded.visibility).toBe(config.visibility);
    expect(expanded.sharedWithUsers).toEqual(config.sharedWithUsers);
    expect((await getServerEnvironment(expanded)).HUB_SECRET).toBeUndefined();
  });

  it.each(['admin', undefined])('preserves trusted process expansion for %s', async (owner) => {
    expect(
      (await expandServerConfig({ owner, headers: { Secret: '${HUB_SECRET}' } })).headers.Secret,
    ).toBe('synthetic-hub-secret');
  });
  it('keeps resolved personal credential values literal', async () => {
    const env = await getServerEnvironment({
      owner: 'admin',
      credentialTemplate: [{ target: 'env', name: 'KEY' }],
      env: { KEY: 'literal-${HUB_SECRET}' },
    });
    expect(env.KEY).toBe('literal-${HUB_SECRET}');
  });
});

describe('managed key pool child boundary', () => {
  const pool = {
    enabled: true,
    provider: 'context7' as const,
    keys: [{ id: 'one', label: 'one', value: 'private-pool-key' }],
  };
  it('passes only a placeholder and a server capability to Context7', async () => {
    const env = await getServerEnvironment({ owner: 'admin', keyPool: pool }, 'context7');
    expect(env.CONTEXT7_API_KEY).toBe('ctx7sk-hub-managed');
    expect(env.MCPHUB_KEY_POOL_URL).toMatch(/127\.0\.0\.1.*key-pool\/context7$/);
    expect(env.NODE_OPTIONS).toContain('key_pool_fetch_preload.cjs');
    expect(JSON.stringify(env)).not.toContain('private-pool-key');
  });
  it('installs the Python HTTP boundary for TwelveData', async () => {
    const env = await getServerEnvironment(
      { owner: 'admin', keyPool: { ...pool, provider: 'twelvedata' } },
      'twelvedata',
    );
    expect(env.PYTHONPATH).toContain('key_pool_python');
    expect(env.TWELVE_DATA_API_KEY).toBe('hub-managed');
    expect(JSON.stringify(env)).not.toContain('private-pool-key');
  });
  it('fails closed for an untrusted owner', async () => {
    await expect(
      getServerEnvironment({ owner: 'member', keyPool: pool }, 'context7'),
    ).rejects.toThrow('trusted');
  });
});

test('target environments preserve toolchain variables but require explicit provider credential bindings', async () => {
  const before = process.env;
  process.env = {
    ...before,
    NOTION_API_KEY: 'workspace-global-sentinel',
    UNRELATED_PROVIDER_KEY: 'unrelated-sentinel',
    PATH: '/safe/toolchain',
    NODE_OPTIONS: '--require inherited-account-loader',
  };
  try {
    const config = { owner: 'admin', env: { MCPHUB_CONNECTION_TARGET: 'other/workspace' } };
    const environment = await getServerEnvironment(config);
    expect(environment.PATH).toBe('/safe/toolchain');
    expect(environment.NOTION_API_KEY).toBeUndefined();
    expect(environment.UNRELATED_PROVIDER_KEY).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBeUndefined();
    const explicit = await getServerEnvironment({
      ...config,
      env: { ...config.env, TARGET_KEY: '${NOTION_API_KEY}' },
    });
    expect(explicit.TARGET_KEY).toBe('workspace-global-sentinel');
    expect(explicit.NOTION_API_KEY).toBeUndefined();
  } finally {
    process.env = before;
  }
});

describe('namespaced TwelveData schema compatibility without key rotation', () => {
  it.each(['twelvedata', 'atlas::twelvedata', 'toolathlon::twelvedata'])(
    'keeps the single-key credential and injects compatibility for %s',
    async (name) => {
      const env = await getServerEnvironment(
        { owner: 'admin', env: { TWELVE_DATA_API_KEY: 'single-key' } },
        name,
      );
      expect(env.MCPHUB_TWELVEDATA_COMPAT).toBe('true');
      expect(env.PYTHONPATH).toContain('key_pool_python');
      expect(env.TWELVE_DATA_API_KEY).toBe('single-key');
      expect(env.MCPHUB_KEY_POOL_URL).toBeUndefined();
    },
  );

  it('uses the declared provider for renamed MCPs and account targets', async () => {
    const env = await getServerEnvironment(
      {
        owner: 'admin',
        env: {
          MCPHUB_CONNECTION_TARGET: 'account-a',
          MCPHUB_KEY_POOL_ADAPTER: 'twelvedata',
          TWELVE_DATA_API_KEY: 'single-key',
        },
      },
      'another-bench::prices',
    );
    expect(env.MCPHUB_TWELVEDATA_COMPAT).toBe('true');
    expect(env.PYTHONPATH).toContain('key_pool_python');
    expect(env.TWELVE_DATA_API_KEY).toBe('single-key');
    expect(env.MCPHUB_KEY_POOL_URL).toBeUndefined();
  });
});
