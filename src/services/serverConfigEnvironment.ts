import { slackCacheEnvironment } from './slackCacheService.js';
import { splitServerKey } from '../utils/catalog.js';
import { getKeyPoolProvider } from '../utils/keyPoolCompatibility.js';
import { scopedUsageDirectory } from './usageLogDirectories.js';
import { join } from 'node:path';
import runtimeConfig from '../config/index.js';
import { keyPoolToken } from './keyPoolService.js';
import { replaceEnvVars } from '../config/index.js';
import { getUserDao } from '../dao/index.js';
import { hasCredentialTemplate } from '../utils/credentialTemplate.js';
import type { ServerConfig } from '../types/index.js';
import { supportsFetchRelay } from '../utils/relayCompatibility.js';

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
  const expansionSource = trusted ? process.env : {};
  // Hub's relay bootstrap account must not become an implicit MCP credential.
  const source = Object.fromEntries(
    Object.entries(expansionSource).filter(
      ([key]) => !key.startsWith('IPWO_PROXY_') && !key.startsWith('MCP_RELAY_'),
    ),
  );
  const name = serverName || config.name || '';
  let relay: Record<string, string> = {};
  const relayCompatible = supportsFetchRelay(config);
  if (config.relay?.enabled && !relayCompatible)
    throw new Error('This MCP connection has no /v1/fetch relay adapter');
  if (trusted && relayCompatible) {
    const { getRelayEnvironment } = await import('./atlasConfigService.js');
    relay = await getRelayEnvironment(name, config.relay, true);
  }
  const environment = {
    ...(source as Record<string, string>),
    ...(hasCredentialTemplate(config)
      ? config.env
      : replaceEnvVars(config.env || {}, expansionSource)),
    ...relay,
  };
  if (config.env?.MCPHUB_CONNECTION_TARGET) {
    for (const key of Object.keys(environment)) {
      if (!TARGET_TOOLCHAIN_ENV.has(key) && !(key in (config.env || {})) && !(key in relay))
        delete environment[key];
    }
  }
  Object.assign(environment, await slackCacheEnvironment(name, config, environment));
  if (
    trusted &&
    (splitServerKey(name).name === 'twelvedata' ||
      getKeyPoolProvider(config) === 'twelvedata' ||
      config.keyPool?.provider === 'twelvedata')
  ) {
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
  if (trusted && name && process.env.MCP_USAGE_LOG_DIR) {
    environment.MCP_USAGE_LOG_DIR = scopedUsageDirectory(process.env.MCP_USAGE_LOG_DIR, name);
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
