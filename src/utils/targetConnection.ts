import type { TargetConnection } from '../types/targetConnection.js';
import { ServerConfigValidationError } from './serverConfigValidation.js';
import { normalizeKeyPool } from './keyPool.js';
import { normalizeFetchRelay } from './serviceControls.js';
export function validateTargetPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 160 &&
    /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value)
  );
}
export function normalizeTargetConnections(value: unknown): TargetConnection[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 100)
    throw new ServerConfigValidationError('Invalid target connections');
  const paths = new Set<string>();
  return value.map((entry: TargetConnection) => {
    if (
      !entry ||
      !validateTargetPath(entry.path) ||
      paths.has(entry.path) ||
      !['static', 'task'].includes(entry.kind)
    )
      throw new ServerConfigValidationError('Target paths must be unique exact paths');
    paths.add(entry.path);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')
      throw new ServerConfigValidationError('Invalid target enabled flag');
    if (
      entry.implementation !== undefined &&
      !['native', 'wrapper', 'custom'].includes(entry.implementation)
    )
      throw new ServerConfigValidationError('Invalid target implementation');
    if (
      entry.version !== undefined &&
      (typeof entry.version !== 'string' ||
        entry.version.length > 160 ||
        [...entry.version].some((char) => char.charCodeAt(0) < 32))
    )
      throw new ServerConfigValidationError('Invalid target version');
    const lists: Pick<TargetConnection, 'allowedKeyIds' | 'allowedUsers'> = {};
    for (const field of ['allowedKeyIds', 'allowedUsers'] as const) {
      if (entry[field] !== undefined) {
        if (
          !Array.isArray(entry[field]) ||
          entry[field]!.some((v) => typeof v !== 'string' || !v.trim() || v.length > 160)
        )
          throw new ServerConfigValidationError('Invalid target access list');
        lists[field] = [...new Set(entry[field])];
      }
    }
    let config: TargetConnection['config'];
    if (entry.kind === 'static') {
      if (!entry.config || typeof entry.config !== 'object' || Array.isArray(entry.config))
        throw new ServerConfigValidationError('Static targets require connection configuration');
      config = {};
      for (const field of ['type', 'url', 'command', 'args', 'env', 'headers', 'options'] as const)
        if (entry.config[field] !== undefined)
          Object.assign(config, { [field]: entry.config[field] });
      config.type = config.type || (config.url ? 'streamable-http' : 'stdio');
      if (config.type && !['stdio', 'sse', 'streamable-http'].includes(config.type))
        throw new ServerConfigValidationError('Unsupported target transport');
      if (
        (config.url !== undefined && typeof config.url !== 'string') ||
        (config.command !== undefined && typeof config.command !== 'string') ||
        (config.args !== undefined &&
          (!Array.isArray(config.args) || config.args.some((v) => typeof v !== 'string')))
      )
        throw new ServerConfigValidationError('Invalid target transport configuration');
      for (const field of ['env', 'headers'] as const)
        if (
          config[field] !== undefined &&
          (!config[field] ||
            typeof config[field] !== 'object' ||
            Array.isArray(config[field]) ||
            Object.values(config[field]!).some((v) => typeof v !== 'string'))
        )
          throw new ServerConfigValidationError('Invalid target credentials');
      if (config.type === 'stdio' ? !config.command?.trim() : !config.url?.trim())
        throw new ServerConfigValidationError('Each static target requires its own command or URL');
      config.keyPool = normalizeKeyPool(entry.config.keyPool);
      if (config.type !== 'stdio' && config.keyPool?.enabled)
        throw new ServerConfigValidationError(
          'Target key pools require a compatible stdio wrapper',
        );
      if (config.type === 'stdio') delete config.url;
      else {
        delete config.command;
        delete config.args;
      }
      config.relay = normalizeFetchRelay(entry.config.relay);
    }
    if (entry.kind === 'task' && entry.config) {
      config = { relay: normalizeFetchRelay(entry.config.relay) };
      if (entry.config.env?.MCPHUB_RELAY_ADAPTER === 'fetch-v1')
        config.env = { MCPHUB_RELAY_ADAPTER: 'fetch-v1' };
    }
    return {
      path: entry.path,
      kind: entry.kind,
      ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
      ...(entry.implementation ? { implementation: entry.implementation } : {}),
      ...(entry.version?.trim() ? { version: entry.version.trim() } : {}),
      ...lists,
      ...(config ? { config } : {}),
    };
  });
}
