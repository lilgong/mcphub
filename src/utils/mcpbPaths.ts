import { splitServerKey, validateServerKey } from './catalog.js';

/** Literal percent escapes are decoded by packages that dynamically import filesystem paths. */
export function mcpbServerDirectoryName(key: string): string {
  const validation = validateServerKey(key);
  if (!validation.valid) throw new Error(validation.message);
  const { catalog, name } = splitServerKey(validation.normalized!);
  // '~' is disallowed in logical names, making scoped and public paths unambiguous.
  return `server-${catalog ? `${catalog}~${name}` : name}`;
}
