import { validateServerName } from './serverNameValidation.js';

const CATALOG_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
const SEPARATOR = '::';

/** Public names remain unchanged; scoped keys are shared by every runtime and DAO. */
export function splitServerKey(key: string): { catalog: string; name: string } {
  const index = key.indexOf(SEPARATOR);
  if (index > 0 && CATALOG_PATTERN.test(key.slice(0, index))) {
    return { catalog: key.slice(0, index), name: key.slice(index + SEPARATOR.length) };
  }
  return { catalog: '', name: key };
}

export function serverKey(name: string, catalog: unknown = ''): string {
  if (catalog === undefined || catalog === null) catalog = '';
  if (typeof catalog !== 'string' || (catalog !== '' && !CATALOG_PATTERN.test(catalog))) {
    throw new Error(
      'Catalog must start with a lowercase letter and contain at most 48 lowercase letters, digits, underscores or hyphens',
    );
  }
  const validation = validateServerName(name);
  if (!validation.valid) throw new Error(validation.message);
  return catalog ? `${catalog}${SEPARATOR}${validation.normalized}` : validation.normalized!;
}

export function validateServerKey(name: unknown, catalog?: unknown) {
  try {
    if (typeof name !== 'string') return validateServerName(name);
    const existing = splitServerKey(name);
    const normalized = serverKey(existing.name, catalog ?? existing.catalog);
    return { valid: true, normalized, message: undefined };
  } catch (error) {
    return { valid: false, message: (error as Error).message, normalized: undefined };
  }
}

export function mcpServerPath(key: string): string {
  const { catalog, name } = splitServerKey(key);
  return `/mcp/${catalog ? `${encodeURIComponent(catalog)}/` : ''}${encodeURIComponent(name)}`;
}
