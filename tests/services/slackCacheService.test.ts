import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getServerEnvironment } from '../../src/services/serverConfigEnvironment.js';

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: () => ({ findByUsername: async () => ({ isAdmin: true }) }),
}));

describe('Slack upstream cache identity', () => {
  let directory: string;
  const original = process.env;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcphub-slack-cache-'));
    process.env = {
      ...original,
      XDG_CACHE_HOME: directory,
      SLACK_MCP_USERS_CACHE: '/shared/users.json',
      SLACK_MCP_CHANNELS_CACHE: '/shared/channels.json',
    };
  });
  afterEach(async () => {
    process.env = original;
    await rm(directory, { recursive: true, force: true });
  });
  const config = (target = 'official', token = 'test-workspace-token') => ({
    owner: 'admin',
    env: { MCPHUB_CONNECTION_TARGET: target, SLACK_MCP_XOXP_TOKEN: token },
  });

  it('isolates catalogs and targets even when their credentials are identical', async () => {
    const entries = await Promise.all([
      getServerEnvironment(config('official'), 'atlas::slack'),
      getServerEnvironment(config('fixture3'), 'atlas::slack'),
      getServerEnvironment(config('official'), 'toolathlon::slack'),
      getServerEnvironment(config('official'), 'slack'),
    ]);
    expect(new Set(entries.map((env) => env.SLACK_MCP_CHANNELS_CACHE)).size).toBe(4);
    expect(new Set(entries.map((env) => env.SLACK_MCP_USERS_CACHE)).size).toBe(4);
    for (const [index, env] of entries.entries()) {
      expect(env.SLACK_MCP_CHANNELS_CACHE).not.toContain('test-workspace-token');
      expect(env.SLACK_MCP_USERS_CACHE.startsWith(directory)).toBe(true);
      expect((await stat(dirname(env.SLACK_MCP_USERS_CACHE))).mode & 0o777).toBe(0o700);
      await writeFile(env.SLACK_MCP_USERS_CACHE, JSON.stringify({ workspace: index }));
    }
    for (const [index, env] of entries.entries()) {
      expect(JSON.parse(await readFile(env.SLACK_MCP_USERS_CACHE, 'utf8'))).toEqual({
        workspace: index,
      });
    }
  });

  it('reuses its own cache after reconnect but starts fresh after credential replacement', async () => {
    const first = await getServerEnvironment(config(), 'atlas::slack');
    await writeFile(first.SLACK_MCP_CHANNELS_CACHE, 'previous-account');
    const same = await getServerEnvironment(config(), 'atlas::slack');
    expect(same.SLACK_MCP_CHANNELS_CACHE).toBe(first.SLACK_MCP_CHANNELS_CACHE);
    const changed = await getServerEnvironment(config('official', 'new-token'), 'atlas::slack');
    expect(changed.SLACK_MCP_CHANNELS_CACHE).not.toBe(first.SLACK_MCP_CHANNELS_CACHE);
    await expect(readFile(changed.SLACK_MCP_CHANNELS_CACHE)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves explicit operator cache paths while isolating unspecified files', async () => {
    const custom = join(directory, 'custom-channels.json');
    const base = config();
    const env = await getServerEnvironment(
      { ...base, env: { ...base.env, SLACK_MCP_CHANNELS_CACHE: custom } },
      'atlas::slack',
    );
    expect(env.SLACK_MCP_CHANNELS_CACHE).toBe(custom);
    expect(env.SLACK_MCP_USERS_CACHE).not.toBe('/shared/users.json');
  });

  it('recognizes renamed Slack registrations from credentials without affecting other MCPs', async () => {
    const slack = await getServerEnvironment(config(), 'benchmark::chat');
    expect(slack.SLACK_MCP_USERS_CACHE.startsWith(directory)).toBe(true);
    const other = await getServerEnvironment(
      { owner: 'admin', env: { MCPHUB_CONNECTION_TARGET: 'official' } },
      'benchmark::notion',
    );
    expect(other.SLACK_MCP_USERS_CACHE).toBeUndefined();
    expect(other.SLACK_MCP_CHANNELS_CACHE).toBeUndefined();
  });
});
