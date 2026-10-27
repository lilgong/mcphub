import { createPrivateKey } from 'node:crypto';
import { normalizePrivateKeyText } from './workspaceDocuments.js';

/** Validate only recognizable unencrypted PEM keys; never interpret ordinary secrets. */
export function normalizeCredentialPrivateKeys(text: string): string {
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (!/^\s*-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/.test(value)) return value;
      const key = normalizePrivateKeyText(value);
      try {
        createPrivateKey(key);
      } catch {
        // Do not expose OpenSSL input, key material or provider error details.
        throw new Error('Invalid PEM private key');
      }
      return key;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    return value;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return normalize(text) as string;
  }
  const normalized = normalize(parsed);
  return JSON.stringify(normalized) === JSON.stringify(parsed)
    ? text
    : JSON.stringify(normalized, null, 2);
}
