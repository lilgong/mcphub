import { sanitizeStringForLogging } from './serialization.js';

/** Keep bounded failure diagnostics, never arbitrary result objects or request arguments. */
export function callErrorMessage(value: unknown): string | undefined {
  const read = (item: unknown, depth = 0): string => {
    if (depth > 10 || item == null) return '';
    if (typeof item === 'string') {
      try {
        const parsed: unknown = item.length <= 65536 ? JSON.parse(item) : undefined;
        if (parsed && typeof parsed === 'object') return read(parsed, depth + 1);
      } catch {
        /* A provider may return a plain-text error. */
      }
      return item;
    }
    if (item instanceof Error) return item.message;
    if (Array.isArray(item))
      return item
        .slice(0, 8)
        .map((entry) => read(entry, depth + 1))
        .filter(Boolean)
        .join('\n');
    if (typeof item !== 'object') return '';
    const record = item as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', 'text', 'content', 'structuredContent']) {
      const text = read(record[key], depth + 1);
      if (text) return text;
    }
    return '';
  };
  const text = read(value);
  if (!text) return undefined;
  // Sanitize before truncation so a cut credential cannot evade masking.
  return sanitizeStringForLogging(text)
    .replace(/\bAIza[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]')
    .split('')
    .filter(
      (character) =>
        character === '\n' ||
        character === '\t' ||
        (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    )
    .join('')
    .slice(0, 4096);
}
