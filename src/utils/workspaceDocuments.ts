import type { WorkspaceCredentialFile } from '../types/workspace.js';

/** Pasted PEM values sometimes contain JSON escape sequences instead of line breaks. */
export function normalizePrivateKeyText(value: string): string {
  if (!/^\s*-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/.test(value)) return value;
  return value.replace(/\\r\\n|\\n/g, '\n').replace(/\r\n/g, '\n');
}

export function initialDocument(file: WorkspaceCredentialFile): string {
  if (file.template) return JSON.stringify(JSON.parse(file.template), null, 2);
  if (file.format === 'json') return '{}';
  if (file.format === 'env')
    return (
      (file.fields || [])
        .map((field) => `${field.name}=${JSON.stringify(field.default || '')}`)
        .join('\n') + '\n'
    );
  return '';
}
export function documentField(file: WorkspaceCredentialFile, text: string, name: string): unknown {
  if (file.format === 'json') {
    let value: unknown = JSON.parse(text);
    for (const key of name.split('.'))
      value =
        value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    return value;
  }
  const line = text.split('\n').find((line) => line.trim().startsWith(name + '='));
  const raw =
    line
      ?.trim()
      .slice(name.length + 1)
      .trim() || '';
  if (raw.startsWith('"')) {
    const quoted = raw.match(/^"(?:\\.|[^"\\])*"/)?.[0] || raw;
    try {
      return JSON.parse(quoted);
    } catch {
      return quoted.slice(1, -1);
    }
  }
  if (raw.startsWith("'")) return raw.slice(1, raw.lastIndexOf("'"));
  return raw;
}
export function updateDocumentField(
  file: WorkspaceCredentialFile,
  text: string,
  name: string,
  value: unknown,
): string {
  if (typeof value === 'string') value = normalizePrivateKeyText(value);
  if (file.format === 'json') {
    const root: unknown = JSON.parse(text);
    if (!root || typeof root !== 'object' || Array.isArray(root))
      throw new Error('JSON object required');
    let node = root as Record<string, unknown>;
    const parts = name.split('.');
    if (parts.some((key) => ['__proto__', 'constructor', 'prototype', ''].includes(key)))
      throw new Error('Invalid field');
    for (const key of parts.slice(0, -1)) {
      if (
        !Object.prototype.hasOwnProperty.call(node, key) ||
        !node[key] ||
        typeof node[key] !== 'object' ||
        Array.isArray(node[key])
      )
        node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
    return JSON.stringify(root, null, 2);
  }
  const lines = text.trimEnd().split('\n');
  const index = lines.findIndex((line) => line.trim().startsWith(name + '='));
  const next = `${name}=${JSON.stringify(value)}`;
  if (index < 0) lines.push(next);
  else lines[index] = next;
  return lines.filter(Boolean).join('\n') + '\n';
}
export function validateDocument(file: WorkspaceCredentialFile, text: string): boolean {
  if (file.format !== 'json') return true;
  try {
    const value: unknown = JSON.parse(text);
    return !!value && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}
