import type { IncomingHttpHeaders } from 'node:http';

const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function blockedHopHeaders(headers: { connection?: unknown }): Set<string> {
  return new Set([
    ...hopHeaders,
    ...String(headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((name) => name.trim()),
  ]);
}

/** Preserve business headers while keeping Hub/connection credentials at the boundary. */
export function forwardingRequestHeaders(
  headers: IncomingHttpHeaders,
  operator: Record<string, string> = {},
): Record<string, string> {
  const blocked = blockedHopHeaders(headers);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      blocked.has(lower) ||
      ['host', 'cookie', 'forwarded', 'x-real-ip'].includes(lower) ||
      lower.startsWith('x-forwarded-') ||
      lower.startsWith('x-mcphub-') ||
      [
        'authorization',
        'x-api-key',
        'api-key',
        'apikey',
        'x-auth-token',
        'x-access-token',
        'access-token',
        'x-refresh-token',
        'x-session-token',
      ].includes(lower)
    )
      continue;
    result[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  // Operator credentials replace client credentials, case-insensitively.
  for (const [name, value] of Object.entries(operator)) {
    const lower = name.toLowerCase();
    if (
      blocked.has(lower) ||
      ['host', 'cookie', 'content-length'].includes(lower) ||
      lower.startsWith('x-mcphub-')
    )
      continue;
    result[lower] = value;
  }
  return result;
}

/** Response cookies remain isolated; other end-to-end metadata is preserved. */
export function forwardingResponseHeaders(
  headers: Record<string, unknown>,
): Record<string, string | string[]> {
  const blocked = blockedHopHeaders(headers);
  blocked.add('set-cookie');
  blocked.add('cache-control');
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (blocked.has(name.toLowerCase())) continue;
    if (typeof value === 'string' || typeof value === 'number')
      result[name.toLowerCase()] = String(value);
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
      result[name.toLowerCase()] = value;
  }
  return result;
}

/** Keep redirects within this resource routed through Hub; resolve other locations upstream. */
export function forwardingLocation(
  location: string,
  url: string,
  base: string,
  clientPrefix: string,
): string {
  const destination = new URL(location, url);
  const configured = new URL(base);
  const prefix = configured.pathname.replace(/\/$/, '');
  if (
    destination.origin === configured.origin &&
    !(destination.pathname === prefix && configured.pathname !== prefix) &&
    !destination.username &&
    !destination.password &&
    (destination.pathname === prefix || destination.pathname.startsWith(prefix + '/'))
  ) {
    return (
      clientPrefix +
      destination.pathname.slice(prefix.length) +
      destination.search +
      destination.hash
    );
  }
  return destination.href;
}
