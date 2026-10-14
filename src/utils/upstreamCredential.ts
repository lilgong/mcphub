import { createHash } from 'node:crypto';
export function upstreamCredential(value: string, role: string) {
  const key = value.trim().replace(/^Bearer\s+/i, '');
  return {
    role,
    id: createHash('sha256').update(key).digest('hex').slice(0, 16),
    suffix: key.length > 1 ? key.slice(-Math.min(4, key.length - 1)) : '',
  };
}
