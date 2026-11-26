import { upstreamCredential } from './upstreamCredential.js';

/** Resolve historical fingerprints using current configuration; never return raw values. */
export function upstreamCredentialSuffixes(configuration: unknown): Map<string, string> {
  const suffixes = new Map<string, string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 12) return;
    if (typeof value === 'string') {
      if (!value.trim() || value.includes('${')) return;
      const credential = upstreamCredential(value, '');
      suffixes.set(credential.id, credential.suffix);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  visit(configuration, 0);
  return suffixes;
}
