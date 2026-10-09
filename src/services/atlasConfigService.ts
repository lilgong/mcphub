import { getSystemConfigDao, getCredentialBindingDao } from '../dao/DaoFactory.js';
import { encryptCredentialValues, decryptCredentialValues } from './credentialBindingService.js';
import { getCachedSystemConfig, setCachedSystemConfig } from '../utils/systemConfigCache.js';
import { toolCallScheduler } from './toolCallSchedulerService.js';
import type { FetchRelayConfig } from '../types/serviceControls.js';
import type { AtlasConfig, ToolCallPolicy } from '../types/atlas.js';

const RELAY_BINDING = { serverName: '$atlas-relay', username: '$system' };
export const RELAY_SERVERS = new Set(['arxiv', 'pubmed', 'osm-mcp-server', 'wikipedia']);
export const BASE_POLICY: ToolCallPolicy = {
  enabled: true,
  concurrency: 1,
  minIntervalMs: 0,
  maxQueued: 100,
  queueTimeoutMs: 60000,
  rateLimitBackoffMs: 2000,
  maxBackoffMs: 60000,
  scope: 'server',
};

export function validateAtlasConfig(value: unknown): AtlasConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid Atlas settings');
  const data = value as AtlasConfig;
  if (!data.policies || typeof data.policies !== 'object' || Array.isArray(data.policies))
    throw new Error('Invalid service policies');
  const policies: Record<string, ToolCallPolicy> = Object.create(null);
  if (Object.keys(data.policies).length > 500) throw new Error('Too many service policies');
  for (const [name, item] of Object.entries(data.policies)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) || !item || typeof item !== 'object')
      throw new Error('Invalid service policy');
    if (typeof item.enabled !== 'boolean' || !['server', 'principal'].includes(item.scope))
      throw new Error('Invalid policy scope');
    const ranges = {
      concurrency: [1, 100],
      minIntervalMs: [0, 600000],
      maxQueued: [1, 10000],
      queueTimeoutMs: [100, 600000],
      rateLimitBackoffMs: [0, 600000],
      maxBackoffMs: [0, 600000],
    } as const;
    for (const [field, [min, max]] of Object.entries(ranges)) {
      const number = item[field as keyof typeof ranges];
      if (!Number.isInteger(number) || number < min || number > max)
        throw new Error(`Invalid ${field}`);
    }
    if (item.maxBackoffMs < item.rateLimitBackoffMs)
      throw new Error('Maximum cooldown must cover base cooldown');
    policies[name] = { ...item };
  }
  const relay = data.relay;
  if (
    !relay ||
    typeof relay.enabled !== 'boolean' ||
    typeof relay.url !== 'string' ||
    relay.url.length > 2048 ||
    !Number.isInteger(relay.timeoutSeconds) ||
    relay.timeoutSeconds < 1 ||
    relay.timeoutSeconds > 600
  )
    throw new Error('Invalid relay settings');
  const url = relay.url.trim().replace(/\/+$/, '');
  if (url) {
    const parsed = new URL(url);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error('Relay must use an HTTP(S) URL without embedded credentials');
  } else if (relay.enabled) throw new Error('Relay URL is required');
  return { policies, relay: { enabled: relay.enabled, url, timeoutSeconds: relay.timeoutSeconds } };
}

export async function getAtlasConfig(): Promise<AtlasConfig> {
  const config = await getSystemConfigDao().get();
  return config.atlas ?? { policies: {}, relay: { enabled: false, url: '', timeoutSeconds: 90 } };
}

export async function saveAtlasConfig(
  config: AtlasConfig,
  token?: string,
  clearToken = false,
): Promise<void> {
  config = validateAtlasConfig(config);
  const old = await getAtlasConfig();
  const busy = toolCallScheduler.stats();
  for (const [name, policy] of Object.entries(config.policies)) {
    if (
      old.policies[name] &&
      old.policies[name].scope !== policy.scope &&
      (busy[name]?.active || busy[name]?.queued)
    )
      throw new Error('Wait for the service to become idle before changing credential scope');
  }
  if (
    token !== undefined &&
    token !== '' &&
    (!token.trim() || /\s/.test(token) || token.length > 16384)
  )
    throw new Error('Invalid relay token');
  if (
    config.relay.enabled &&
    (clearToken ||
      (!token &&
        !(await getCredentialBindingDao().get(RELAY_BINDING.serverName, RELAY_BINDING.username))))
  )
    throw new Error('A relay token is required');
  if (token)
    await getCredentialBindingDao().save({
      ...RELAY_BINDING,
      encryptedValues: await encryptCredentialValues(
        RELAY_BINDING.serverName,
        RELAY_BINDING.username,
        { token },
      ),
      updatedAt: new Date().toISOString(),
    });
  if (clearToken) await getCredentialBindingDao().delete(RELAY_BINDING);
  const saved = await getSystemConfigDao().update({ atlas: config });
  setCachedSystemConfig(saved);
  toolCallScheduler.refresh();
}

export async function hasRelayToken(): Promise<boolean> {
  return Boolean(
    await getCredentialBindingDao().get(RELAY_BINDING.serverName, RELAY_BINDING.username),
  );
}

export async function getRelayEnvironment(
  server: string,
  connection?: FetchRelayConfig,
  compatible = false,
): Promise<Record<string, string>> {
  if (!compatible && !connection && !RELAY_SERVERS.has(server)) return {};
  const relay = getCachedSystemConfig()?.atlas?.relay;
  const prefixes = ['MCP'];
  const environment = (url: string, token: string, timeout: number): Record<string, string> =>
    Object.fromEntries(
      [...prefixes].flatMap((prefix) => [
        [`${prefix}_RELAY_URL`, url],
        [`${prefix}_RELAY_TOKEN`, token],
        [`${prefix}_RELAY_TIMEOUT_SECONDS`, String(timeout)],
      ]),
    );
  if (!relay && connection?.enabled) throw new Error('Managed relay is not configured');
  if (!relay) return connection?.enabled === false ? environment('', '', 90) : {};
  if (connection?.enabled && !relay.enabled) throw new Error('Managed relay is disabled');
  const enabled = relay.enabled && connection?.enabled !== false;
  let token = '';
  if (enabled) {
    const binding = await getCredentialBindingDao().get(
      RELAY_BINDING.serverName,
      RELAY_BINDING.username,
    );
    if (!binding) throw new Error('Managed relay credential is unavailable');
    token = (await decryptCredentialValues(binding)).token;
  }
  // Emit the single shared Relay environment for every compatible connection.
  return environment(enabled ? relay.url : '', token, relay.timeoutSeconds);
}
