import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { splitServerKey } from '../utils/catalog.js';

/** Provider wrappers keep their existing record format; the directory supplies identity. */
export function scopedUsageDirectory(root: string, server: string): string {
  const { catalog, name } = splitServerKey(server);
  return join(root, 'catalogs', catalog || '_public', encodeURIComponent(name));
}

export async function usageLogDirectories(root: string) {
  const result: { directory: string; server?: string; catalog: string }[] = [
    { directory: root, catalog: '_legacy' },
  ];
  const children = async (directory: string) => {
    try {
      return (await readdir(directory, { withFileTypes: true })).filter((item) =>
        item.isDirectory(),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  for (const catalog of await children(join(root, 'catalogs'))) {
    if (catalog.name !== '_public' && !/^[a-z][a-z0-9_-]{0,47}$/.test(catalog.name)) continue;
    for (const server of await children(join(root, 'catalogs', catalog.name))) {
      let name: string;
      try {
        name = decodeURIComponent(server.name);
      } catch {
        continue;
      }
      const scope = catalog.name === '_public' ? '' : catalog.name;
      result.push({
        directory: join(root, 'catalogs', catalog.name, server.name),
        server: scope ? `${scope}::${name}` : name,
        catalog: scope,
      });
    }
  }
  return result;
}

export function matchesLogScope(
  server: string,
  query: { server?: string; catalog?: string },
  catalog = splitServerKey(server).catalog,
) {
  return (
    (query.catalog === undefined || query.catalog === catalog) &&
    (!query.server || server === query.server || splitServerKey(server).name === query.server)
  );
}
