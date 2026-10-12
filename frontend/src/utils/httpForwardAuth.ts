import type { EnvVar } from '../types';

export type HttpAuthMode = 'bearer' | 'header' | 'none';
export interface HttpForwardAuth {
  mode: HttpAuthMode;
  key: string;
  headerName: string;
}

export function suggestedHttpAuth(url: string): HttpAuthMode | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'google.serper.dev') return 'header';
    if (host === 'yibuapi.com') return 'bearer';
  } catch {
    /* An incomplete URL or environment placeholder has no provider hint. */
  }
  return undefined;
}

export function readHttpForwardAuth(url: string, headers: EnvVar[]): HttpForwardAuth {
  const authorization = headers.find((header) => header.key.toLowerCase() === 'authorization');
  if (authorization && (!authorization.value || /^Bearer(?:\s|$)/i.test(authorization.value))) {
    return {
      mode: 'bearer',
      key: authorization.value.replace(/^(?:Bearer(?:\s+|$))+/i, ''),
      headerName: 'Authorization',
    };
  }
  const custom = authorization ?? headers.find((header) => /api[-_]?key|token/i.test(header.key));
  if (custom) return { mode: 'header', key: custom.value, headerName: custom.key };
  return { mode: suggestedHttpAuth(url) ?? 'bearer', key: '', headerName: 'X-API-KEY' };
}

export function authHeaderName(auth: HttpForwardAuth): string {
  return auth.mode === 'bearer' ? 'Authorization' : auth.headerName;
}

/** Preserve unrelated operator headers while replacing the selected auth header. */
export function extraHttpHeaders(headers: EnvVar[], auth: HttpForwardAuth): EnvVar[] {
  const name = authHeaderName(auth).toLowerCase();
  return headers.filter((header) => header.key.toLowerCase() !== name);
}

export function buildHttpAuthHeaders(auth: HttpForwardAuth, extra: EnvVar[]): EnvVar[] {
  if (auth.mode === 'none') return extra;
  const name = authHeaderName(auth).trim();
  const key =
    auth.mode === 'bearer' ? auth.key.trim().replace(/^(?:Bearer\s+)+/i, '') : auth.key.trim();
  const result = extra.filter((header) => header.key.toLowerCase() !== name.toLowerCase());
  if (name && key)
    result.push({ key: name, value: auth.mode === 'bearer' ? `Bearer ${key}` : key });
  return result;
}
