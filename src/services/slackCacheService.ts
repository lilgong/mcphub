import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ServerConfig } from '../types/index.js';
import { splitServerKey } from '../utils/catalog.js';
import { getConfigFilePath } from '../utils/path.js';

const CREDENTIALS = ['SLACK_MCP_XOXP_TOKEN', 'SLACK_MCP_XOXC_TOKEN', 'SLACK_MCP_XOXD_TOKEN'];
const CACHE_FILES = {
  SLACK_MCP_CHANNELS_CACHE: '.channels_cache_v2.json',
  SLACK_MCP_USERS_CACHE: '.users_cache.json',
};

/** Slack's default relative cache files are unsafe for multiple accounts in one Hub. */
export async function slackCacheEnvironment(
  name: string,
  config: ServerConfig,
  environment: Record<string, string>,
): Promise<Record<string, string>> {
  if (!name || (config.type && config.type !== 'stdio')) return {};
  const logicalName = splitServerKey(name).name;
  const slack =
    ['slack', 'slack-mcp-server'].includes(logicalName) ||
    CREDENTIALS.some((key) => key in (config.env || {})) ||
    config.args?.some((arg) => /(?:^|\/)slack-mcp-server(?:@|\/|-linux-|$)/.test(arg));
  if (!slack) return {};

  const defaults = Object.entries(CACHE_FILES).filter(([key]) => !config.env?.[key]?.trim());
  if (!defaults.length) return {};
  // Include credentials so changing an account in place cannot reuse its old cache.
  // Neither tokens nor workspace names are exposed in directory names.
  const scope = createHash('sha256')
    .update(
      JSON.stringify([
        name,
        config.env?.MCPHUB_CONNECTION_TARGET || '',
        CREDENTIALS.map((key) => environment[key] || ''),
      ]),
    )
    .digest('hex');
  const root =
    process.env.XDG_CACHE_HOME ||
    join(dirname(getConfigFilePath('mcp_settings.json')), 'data', '.cache');
  const directory = join(root, 'mcphub', 'slack', scope);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Explicit per-connection paths remain an operator override. Ignore inherited
  // process-wide paths when the connection itself did not configure them.
  return Object.fromEntries(defaults.map(([key, filename]) => [key, join(directory, filename)]));
}
