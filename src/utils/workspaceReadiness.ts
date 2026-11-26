import { splitServerKey } from './catalog.js';
import { documentField } from './workspaceDocuments.js';
import type { ServerConfig } from '../types/index.js';
import type { WorkspaceCredentials } from '../types/workspace.js';

/** Presence checks only: never contact upstreams or expose saved credential values. */
export function workspaceReadiness(
  account: WorkspaceCredentials,
  servers: (ServerConfig & { name: string })[],
) {
  const missing = new Set<string>();
  const present = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  for (const server of servers) {
    const schema = server.workspaceSchema;
    if (
      server.enabled === false ||
      splitServerKey(server.name).catalog !== account.catalog ||
      !schema?.enabled
    )
      continue;
    const require = (field: string) => missing.add(`${splitServerKey(server.name).name}: ${field}`);
    for (const field of schema.values || []) {
      if (field.required && !present(account.values[field.name] || field.default))
        require(field.name);
    }
    for (const file of schema.files || []) {
      const text = account.files[file.path];
      if (file.required && !present(text)) require(file.path);
      for (const field of file.fields || []) {
        if (!field.required) continue;
        let value: unknown;
        try {
          value = text ? documentField(file, text, field.name) : undefined;
        } catch {
          /* Incomplete JSON remains editable. */
        }
        if (!present(value || field.default)) require(`${file.path} (${field.name})`);
      }
    }
  }
  return { ready: missing.size === 0, missing: [...missing].sort() };
}
