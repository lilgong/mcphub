import { splitServerKey, validateServerKey } from '../../../src/utils/catalog';
import type { ServerConfig } from '../types';

export interface ImportJsonFormat {
  mcpServers: Record<string, ServerConfig>;
}

export interface NormalizedServer {
  name: string;
  config: Partial<ServerConfig>;
}

export interface ImportIssue {
  name: string;
  message: string;
}

export interface NormalizeResult {
  servers: NormalizedServer[];
  issues: ImportIssue[];
}

// Remote transport types that require a `url`.
const REMOTE_TYPES = ['sse', 'streamable-http', 'http-proxy'];

// Keys that mcphub understands on a server config. Anything else is either a
// typo or copied from another tool's schema (e.g. an `auth` block), and would
// otherwise be silently dropped during import — leaving the user confused when
// the imported server does not behave as their JSON suggested.
const KNOWN_KEYS = new Set<keyof ServerConfig | string>([
  'type',
  'description',
  'url',
  'command',
  'args',
  'env',
  'headers',
  'options',
  'openapi',
  'oauth',
  'enabled',
  'visibility',
  'keepAliveInterval',
  'enableKeepAlive',
  'perSessionClient',
  'tools',
  'prompts',
  'passthroughHeaders',
  'proxy',
  'targets',
  'keyPool',
  'rateLimit',
  'relay',
  'credentialTemplate',
  'startOnDemand',
  'idleTimeoutMs',
  'resources',
  'sharedWithUsers',
]);

/**
 * Normalize imported server configs and collect human-readable issues.
 *
 * Previous behaviour silently coerced any unrecognized `type` (or a missing
 * `type` on a remote server) into a `stdio` server, and dropped fields such as
 * `oauth`. That produced opaque "Failed to import servers" errors downstream.
 * We now validate up-front and name the exact server/field at fault.
 */
export const normalizeImportedServers = (parsed: ImportJsonFormat, catalog?: string): NormalizeResult => {
  const servers: NormalizedServer[] = [];
  const issues: ImportIssue[] = [];

  const seen = new Set<string>();
  for (const [name, rawConfig] of Object.entries(parsed.mcpServers)) {
    const existing = splitServerKey(name);
    if (catalog && existing.catalog && existing.catalog !== catalog) {
      issues.push({ name, message: `Server belongs to namespace "${existing.catalog}", not "${catalog}".` });
      continue;
    }
    const identity = validateServerKey(name, catalog || undefined);
    if (!identity.valid) {
      issues.push({ name, message: identity.message || 'Invalid server identity' });
      continue;
    }
    if (seen.has(identity.normalized!)) {
      issues.push({ name, message: `Duplicate destination "${identity.normalized}".` });
      continue;
    }
    seen.add(identity.normalized!);
    const config = (rawConfig ?? {}) as ServerConfig & Record<string, unknown>;
    const normalizedConfig: Partial<ServerConfig> = {};

    // Surface unknown top-level keys (e.g. the `auth` block some tools use).
    const unknownKeys = Object.keys(config).filter((key) => !KNOWN_KEYS.has(key));
    if (unknownKeys.length > 0) {
      issues.push({
        name,
        message: `unknown field(s) "${unknownKeys.join('", "')}" — not part of the mcphub server schema. For OAuth, use an "oauth" object (e.g. {"scopes":["email"]}).`,
      });
      continue;
    }

    if (
      config.type === 'sse' ||
      config.type === 'streamable-http' ||
      config.type === 'http-proxy'
    ) {
      normalizedConfig.type = config.type;
      normalizedConfig.url = config.url;
      if (config.headers) {
        normalizedConfig.headers = config.headers;
      }
      if (config.type === 'http-proxy') {
        normalizedConfig.description = config.description;
        normalizedConfig.options = config.options;
        normalizedConfig.enabled = config.enabled;
      }
      if (config.oauth) {
        normalizedConfig.oauth = config.oauth;
      }
      if (!config.url) {
        issues.push({
          name,
          message: `"${config.type}" servers require a "url" field.`,
        });
        continue;
      }
    } else if (config.type === 'openapi') {
      normalizedConfig.type = 'openapi';
      normalizedConfig.openapi = config.openapi;
    } else if (config.type === undefined || config.type === 'stdio') {
      // A url without a recognized remote type is a common mistake (e.g.
      // "type":"http"). Only treat as stdio when there is no url.
      if (config.url && !config.command) {
        issues.push({
          name,
          message: `has a "url" but type "${config.type ?? 'stdio'}". Use "streamable-http" or "sse" for remote servers.`,
        });
        continue;
      }
      normalizedConfig.type = 'stdio';
      normalizedConfig.command = config.command;
      normalizedConfig.args = config.args || [];
      if (config.env) {
        normalizedConfig.env = config.env;
      }
      if (config.options) {
        normalizedConfig.options = config.options;
      }
      if (!config.command) {
        issues.push({
          name,
          message: `stdio servers require a "command" field.`,
        });
        continue;
      }
    } else {
      // Unknown/unsupported type such as "http".
      const suggestion = REMOTE_TYPES.includes(String(config.type))
        ? ''
        : ` Did you mean "streamable-http"? Supported types: stdio, sse, streamable-http, openapi, http-proxy.`;
      issues.push({
        name,
        message: `unsupported type "${config.type}".${suggestion}`,
      });
      continue;
    }

    servers.push({ name: identity.normalized!, config: { ...config, ...normalizedConfig } });
  }

  return { servers, issues };
};
