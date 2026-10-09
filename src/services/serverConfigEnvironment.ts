import { join } from 'node:path';
import runtimeConfig from '../config/index.js';
import { keyPoolToken } from './keyPoolService.js';
import { replaceEnvVars } from '../config/index.js';
import { getUserDao } from '../dao/index.js';
import { hasCredentialTemplate } from '../utils/credentialTemplate.js';
import type { ServerConfig } from '../types/index.js';

// Target children may inherit toolchain settings, never implicit provider credentials.
const TARGET_TOOLCHAIN_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'PWD',
  'NODE_ENV',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONUNBUFFERED',
  'VIRTUAL_ENV',
  'UV_CACHE_DIR',
  'UV_TOOL_DIR',
  'UV_TOOL_BIN_DIR',
  'UV_PYTHON_INSTALL_DIR',
  'NPM_CONFIG_CACHE',
  'npm_config_cache',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
]);

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
  if (config.env?.MCPHUB_CONNECTION_TARGET) {
    for (const key of Object.keys(environment)) {
      if (!TARGET_TOOLCHAIN_ENV.has(key) && !(key in (config.env || {})) && !(key in relay))
        delete environment[key];
    }
  }
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
    const poolName = config.env?.MCPHUB_CONNECTION_TARGET
      ? `${name}@${config.env.MCPHUB_CONNECTION_TARGET}`
      : name;
    environment.MCPHUB_KEY_POOL_URL = `http://127.0.0.1:${runtimeConfig.port}/internal/v1/key-pool/${encodeURIComponent(poolName)}`;
    environment.MCPHUB_KEY_POOL_TOKEN = keyPoolToken(poolName);
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
