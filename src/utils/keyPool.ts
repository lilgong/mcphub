import type { KeyPoolConfig } from '../types/keyPool.js';
import { ServerConfigValidationError } from './serverConfigValidation.js';
export function normalizeKeyPool(value: unknown): KeyPoolConfig | undefined {
  if (value == null) return undefined;
  const input = value as KeyPoolConfig;
  if (
    typeof input.enabled !== 'boolean' ||
    !['context7', 'twelvedata'].includes(input.provider) ||
    !Array.isArray(input.keys) ||
    input.keys.length > 32 ||
    (input.enabled && input.keys.length === 0)
  )
    throw new ServerConfigValidationError('Invalid key pool');
  const ids = new Set<string>();
  const secrets = new Set<string>();
  const keys = input.keys.map((key) => {
    if (
      !key ||
      typeof key.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(key.id) ||
      ids.has(key.id) ||
      typeof key.label !== 'string' ||
      key.label.length > 80 ||
      typeof key.value !== 'string' ||
      !key.value.trim() ||
      key.value.length > 4096 ||
      secrets.has(key.value.trim())
    )
      throw new ServerConfigValidationError(
        'Key pool entries require unique IDs, unique non-empty keys and labels of at most 80 characters',
      );
    ids.add(key.id);
    secrets.add(key.value.trim());
    return { id: key.id, label: key.label.trim() || key.id, value: key.value.trim() };
  });
  return { enabled: input.enabled, provider: input.provider, keys };
}
