import type { ServiceRateLimit, FetchRelayConfig } from '../types/serviceControls.js';
import { ServerConfigValidationError } from './serverConfigValidation.js';

export function normalizeServiceRateLimit(value: unknown): ServiceRateLimit | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as ServiceRateLimit).enabled !== 'boolean'
  )
    throw new ServerConfigValidationError('Invalid MCP rate limit');
  const input = value as ServiceRateLimit;
  const output: ServiceRateLimit = { enabled: input.enabled };
  for (const key of [
    'concurrency',
    'minIntervalMs',
    'maxCalls',
    'windowMs',
    'maxQueued',
    'queueTimeoutMs',
    'rateLimitBackoffMs',
    'maxBackoffMs',
  ] as const) {
    const number = input[key];
    if (number === undefined || number === null) continue;
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number >
        (key === 'concurrency'
          ? 10000
          : key === 'maxCalls' || key === 'maxQueued'
            ? 1000000
            : 2147483647)
    )
      throw new ServerConfigValidationError(`rateLimit.${key} must be a positive integer or unset`);
    output[key] = number;
  }
  if (Boolean(output.maxCalls) !== Boolean(output.windowMs))
    throw new ServerConfigValidationError('Configure both maxCalls and windowMs');
  if (
    output.maxBackoffMs &&
    output.rateLimitBackoffMs &&
    output.maxBackoffMs < output.rateLimitBackoffMs
  )
    throw new ServerConfigValidationError('Maximum cooldown cannot be shorter than base cooldown');
  return output;
}

export function normalizeFetchRelay(value: unknown): FetchRelayConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object')
    throw new ServerConfigValidationError('Invalid relay connection');
  const input = value as FetchRelayConfig;
  if (
    typeof input.enabled !== 'boolean' ||
    (input.envPrefix !== undefined &&
      (typeof input.envPrefix !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.envPrefix)))
  )
    throw new ServerConfigValidationError('Invalid relay connection');
  return {
    enabled: input.enabled,
    ...(input.envPrefix ? { envPrefix: input.envPrefix } : {}),
  };
}
