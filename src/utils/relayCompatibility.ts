import type { FetchRelayConfig } from '../types/serviceControls.js';

type Connection = {
  type?: string;
  args?: string[];
  env?: Record<string, string>;
  relay?: FetchRelayConfig;
};

/** Declaring variables alone does not teach an arbitrary MCP to use /v1/fetch. */
export function supportsFetchRelay(connection: Connection): boolean {
  if (connection.type && connection.type !== 'stdio') return false;
  if (connection.env?.MCPHUB_RELAY_ADAPTER === 'fetch-v1') return true;
  const args = connection.args ?? [];
  return (
    args.some((arg) => /\/(?:arxiv_mcp_compat|pubmed_mcp_compat|osm_mcp_compat)\.py$/.test(arg)) ||
    args.some((arg) =>
      /\/uploads\/mcpb\/server-(?:atlas-)?(?:arxiv|pubmed|osm-mcp-server|wikipedia)(?:-[^/]+)?\/launch\.cjs$/.test(
        arg,
      ),
    ) ||
    /(?:^|:)\S*\/wikipedia_preload(?:$|:)/.test(connection.env?.PYTHONPATH ?? '')
  );
}

/** Display a single Relay configuration entry. */
export function isRelayEnvironmentVariable(name: string): boolean {
  if (name === 'MCPHUB_RELAY_ADAPTER') return true;
  const prefixes = ['MCP'];
  return prefixes.some((prefix) =>
    ['URL', 'TOKEN', 'TIMEOUT_SECONDS'].some((field) => name === `${prefix}_RELAY_${field}`),
  );
}
