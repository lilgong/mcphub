import type { KeyPoolConfig } from '../types/keyPool.js';

/** A rotation adapter must understand credential injection and upstream quota errors. */
export function getKeyPoolProvider(connection: {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}): KeyPoolConfig['provider'] | undefined {
  if (connection.type && connection.type !== 'stdio') return undefined;
  const declared = connection.env?.MCPHUB_KEY_POOL_ADAPTER;
  if (declared === 'context7' || declared === 'twelvedata') return declared;
  const args = connection.args ?? [];
  if (args.some((arg) => /(?:^|\/)@upstash\/context7-mcp(?:@|\/|$)/.test(arg))) return 'context7';
  if (args.some((arg) => /(?:^|\/)twelvedata_mcp_compat\.py$/.test(arg))) return 'twelvedata';
  return undefined;
}

export const isPooledCredential = (name: string, provider?: KeyPoolConfig['provider']) =>
  provider === 'context7'
    ? name === 'CONTEXT7_API_KEY'
    : provider === 'twelvedata' && name === 'TWELVE_DATA_API_KEY';
