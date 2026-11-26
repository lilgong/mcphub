import type { ServerConfig } from '../types/index.js';
import type { TargetConnectionConfig } from '../types/targetConnection.js';

/** Copy launch details, never another account's environment or headers. */
export function accountConnectionDefaults(definition: ServerConfig): TargetConnectionConfig {
  return {
    type:
      definition.type === 'sse' || definition.type === 'streamable-http'
        ? definition.type
        : 'stdio',
    ...(definition.command ? { command: definition.command } : {}),
    ...(definition.args ? { args: [...definition.args] } : {}),
    ...(definition.url ? { url: definition.url } : {}),
    ...(definition.options ? { options: { ...definition.options } } : {}),
    ...(definition.env
      ? {
          env: Object.fromEntries(
            Object.entries(definition.env).map(([key, value]) => [
              key,
              ['PYTHONPATH', 'PYTHONHOME', 'NODE_PATH', 'LD_LIBRARY_PATH'].includes(key)
                ? value
                : '',
            ]),
          ),
        }
      : {}),
    ...(definition.headers
      ? { headers: Object.fromEntries(Object.keys(definition.headers).map((key) => [key, ''])) }
      : {}),
  };
}

export const hasResidentAccounts = (definition: ServerConfig): boolean =>
  definition.workspaceSchema?.enabled === true &&
  definition.workspaceSchema.connection === true &&
  !definition.targets?.some((target) => target.kind === 'task');
