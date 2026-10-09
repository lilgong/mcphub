import { join } from 'node:path';
import runtimeConfig from '../config/index.js';
import { keyPoolToken } from './keyPoolService.js';
import { replaceEnvVars } from '../config/index.js';
import { getUserDao } from '../dao/index.js';
import { hasCredentialTemplate } from '../utils/credentialTemplate.js';
import type { ServerConfig } from '../types/index.js';

/** Ownerless operator configuration is trusted; missing owners fail closed. */
export const getServerEnvironment = async (
  config: ServerConfig & { name?: string },
  serverName?: string,
): Promise<Record<string, string>> => {
  const trusted =
    !config.owner || (await getUserDao().findByUsername(config.owner))?.isAdmin === true;
  const source = trusted ? process.env : {};
  const name = serverName || config.name || '';
  let relay: Record<string, string> = {};
  if (
    trusted &&
    (config.relay || ['arxiv', 'pubmed', 'osm-mcp-server', 'wikipedia'].includes(name))
  ) {
    const { getRelayEnvironment } = await import('./atlasConfigService.js');
    relay = await getRelayEnvironment(name, config.relay);
  }
  const environment = {
    ...(source as Record<string, string>),
    ...(hasCredentialTemplate(config) ? config.env : replaceEnvVars(config.env || {}, source)),
    ...relay,
  };
  if (trusted && (name === 'twelvedata' || config.keyPool?.provider === 'twelvedata')) {
    environment.PYTHONPATH = [
      join(process.cwd(), 'scripts', 'key_pool_python'),
      environment.PYTHONPATH,
    ]
      .filter(Boolean)
      .join(':');
    environment.MCPHUB_TWELVEDATA_COMPAT = 'true';
  }
  if (config.keyPool?.enabled && !trusted)
    throw new Error('Key pools require a trusted operator-owned MCP');
  if (trusted && name && config.keyPool?.enabled) {
    environment.MCPHUB_KEY_POOL_URL = `http://127.0.0.1:${runtimeConfig.port}/internal/v1/key-pool/${encodeURIComponent(name)}`;
    environment.MCPHUB_KEY_POOL_TOKEN = keyPoolToken(name);
    if (config.keyPool.provider === 'context7') {
      const preload = join(process.cwd(), 'scripts', 'key_pool_fetch_preload.cjs');
      environment.NODE_OPTIONS = `${environment.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`;
      environment.CONTEXT7_API_KEY = 'ctx7sk-hub-managed';
    } else {
      environment.TWELVE_DATA_API_KEY = 'hub-managed';
    }
  }
  return environment;
};

export const expandServerConfig = async <T extends ServerConfig>(config: T): Promise<T> => {
  const { owner, visibility, sharedWithUsers, ...transportConfig } = config;
  // Authorization metadata is literal and must never be controlled by expansion values.
  return {
    ...replaceEnvVars(transportConfig, await getServerEnvironment(config)),
    owner,
    visibility,
    sharedWithUsers,
  } as T;
};
