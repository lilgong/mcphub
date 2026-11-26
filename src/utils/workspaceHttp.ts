import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import type { WorkspaceCredentials, WorkspaceHttpBinding } from '../types/workspace.js';
import { documentField } from './workspaceDocuments.js';
import type { ForwardResponse } from '../services/httpForwardService.js';

export function workspaceAssetHost(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern
      .toLowerCase()
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[a-z0-9.-]+');
    return new RegExp(`^${escaped}$`).test(host.toLowerCase());
  });
}

/** Recognize Basic and Bearer representations without emitting either credential. */
export function headerContainsCredential(header: string, credential: string): boolean {
  if (!credential) return false;
  if (header.includes(credential)) return true;
  if (/^Basic\s+/i.test(header)) {
    try {
      return Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64')
        .toString()
        .includes(credential);
    } catch {
      return false;
    }
  }
  return false;
}

/** Only public hostname labels may be interpolated into an operator-declared origin. */
export function workspaceHttpUrl(
  binding: WorkspaceHttpBinding,
  account: WorkspaceCredentials,
): string {
  const url = binding.url.replace(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, field: string) => {
    const value = account.values[field];
    if (!value || !/^[A-Za-z0-9_.-]{1,200}$/.test(value))
      throw new Error('Invalid account endpoint');
    return value.replace(/_/g, '-');
  });
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('Invalid account endpoint');
  return parsed.href;
}

export function workspaceHttpSecret(
  binding: WorkspaceHttpBinding,
  account: WorkspaceCredentials,
): string {
  const auth = binding.credential;
  if (auth.value) return account.values[auth.value] || '';
  if (!auth.file) return '';
  const content = account.files[auth.file];
  if (!content) return '';
  if (!auth.field) return content;
  const value = documentField({ path: auth.file, format: 'json' }, content, auth.field);
  return typeof value === 'string' ? value : '';
}

/** Optional provider-declared application failures; status/body remain untouched. */
export function workspaceHttpResult(
  rule: WorkspaceHttpBinding['responseError'],
  result: ForwardResponse,
): ForwardResponse {
  if (!rule || result.isError) return result;
  try {
    const encoding = result.headers['content-encoding'];
    const decoder =
      encoding === 'gzip'
        ? gunzipSync
        : encoding === 'deflate'
          ? inflateSync
          : encoding === 'br'
            ? brotliDecompressSync
            : undefined;
    const body = decoder ? decoder(result.body, { maxOutputLength: 1024 * 1024 }) : result.body;
    let value: unknown = JSON.parse(body.toString('utf8'));
    for (const part of rule.field.split('.'))
      value =
        value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
    const failed =
      rule.mode === 'false' ? value === false : Array.isArray(value) && value.length > 0;
    return failed ? { ...result, isError: true } : result;
  } catch {
    return result;
  }
}
