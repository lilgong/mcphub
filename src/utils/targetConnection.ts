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
    const taskOptions: Pick<TargetConnection, 'startupEnvKeys' | 'callbackOrigins'> = {};
    if (entry.startupEnvKeys !== undefined) {
      if (
        entry.kind !== 'task' ||
        !Array.isArray(entry.startupEnvKeys) ||
        entry.startupEnvKeys.length > 100 ||
        entry.startupEnvKeys.some(
          (key) =>
            typeof key !== 'string' ||
            !/^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(key) ||
            key.startsWith('MCPHUB_'),
        )
      )
        throw new ServerConfigValidationError('Invalid task startup environment names');
      taskOptions.startupEnvKeys = [...new Set(entry.startupEnvKeys)];
    }
    if (entry.callbackOrigins !== undefined) {
      if (
        entry.kind !== 'task' ||
        !Array.isArray(entry.callbackOrigins) ||
        entry.callbackOrigins.length > 100
      )
        throw new ServerConfigValidationError('Invalid task callback origins');
      taskOptions.callbackOrigins = [
        ...new Set(
          entry.callbackOrigins.map((value) => {
            if (typeof value !== 'string')
              throw new ServerConfigValidationError('Invalid task callback origin');
            let parsed: URL;
            try {
              parsed = new URL(value);
            } catch {
              throw new ServerConfigValidationError('Invalid task callback origin');
            }
            if (
              !['http:', 'https:'].includes(parsed.protocol) ||
              parsed.username ||
              parsed.password ||
              parsed.search ||
              parsed.hash ||
              parsed.pathname !== '/'
            )
              throw new ServerConfigValidationError('Task callbacks require HTTP(S) origins');
            return parsed.origin;
          }),
        ),
      ];
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
      for (const field of ['timeout', 'maxBufferSize'] as const) {
        const value = entry.config.options?.[field];
        if (value !== undefined) {
          if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)
            throw new ServerConfigValidationError(`Invalid task request ${field}`);
          config.options = { ...config.options, [field]: value };
        }
      }
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
      ...taskOptions,
      ...(config ? { config } : {}),
    };
  });
}
