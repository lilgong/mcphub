import type { WorkspaceCredentialField, WorkspaceCredentialSchema } from '../types/workspace.js';

export function validCredentialFile(name: string): boolean {
  return (
    name.length <= 240 &&
    name.startsWith('configs/') &&
    name
      .split('/')
      .every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..') &&
    /\.(json|env|yaml|yml|pem|p8|key|txt)$/.test(name)
  );
}
export function normalizeWorkspaceSchema(value: unknown): WorkspaceCredentialSchema | undefined {
  if (value === undefined || value === null) return undefined;
  const fail = (): never => {
    throw new Error('Invalid workspace credential declaration');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['enabled', 'values', 'files', 'managed'].includes(key)))
    return fail();
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return fail();
  const text = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 1000 || value.includes('\0')) return fail();
    return value;
  };
  const entries = (items: unknown): Record<string, unknown>[] => {
    if (items === undefined) return [];
    if (
      !Array.isArray(items) ||
      items.length > 64 ||
      items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
    )
      return fail();
    return items;
  };
  const parseFields = (items: unknown, nested = false): WorkspaceCredentialField[] =>
    entries(items).map((field) => {
      if (
        Object.keys(field).some(
          (key) =>
            !['name', 'label', 'description', 'secret', 'env', 'multiline', 'default'].includes(
              key,
            ),
        ) ||
        typeof field.name !== 'string' ||
        !(nested ? /^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/ : /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/).test(
          field.name,
        ) ||
        field.name
          .split('.')
          .some((part) => ['__proto__', 'constructor', 'prototype', ''].includes(part)) ||
        (field.env !== undefined &&
          (typeof field.env !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,99}$/.test(field.env))) ||
        (field.secret !== undefined && typeof field.secret !== 'boolean') ||
        (field.multiline !== undefined && typeof field.multiline !== 'boolean') ||
        (field.default !== undefined &&
          (field.secret !== false || typeof field.default !== 'string'))
      )
        return fail();
      return {
        name: field.name,
        label: text(field.label),
        description: text(field.description),
        secret: field.secret !== false,
        ...(field.multiline ? { multiline: true } : {}),
        ...(field.default !== undefined ? { default: text(field.default) } : {}),
        ...(field.env ? { env: field.env as string } : {}),
      };
    });
  const values = parseFields(input.values);
  const files = entries(input.files).map((file) => {
    if (
      Object.keys(file).some(
        (key) =>
          !['path', 'label', 'description', 'directory', 'format', 'template', 'fields'].includes(
            key,
          ),
      ) ||
      typeof file.path !== 'string' ||
      (file.directory !== undefined && typeof file.directory !== 'boolean') ||
      !validCredentialFile(file.directory ? file.path + '/placeholder.json' : file.path)
    )
      return fail();
    if (
      file.format !== undefined &&
      (typeof file.format !== 'string' || !['json', 'env', 'text'].includes(file.format))
    )
      return fail();
    if (file.directory && (file.format || file.template || file.fields)) return fail();
    const fields = parseFields(file.fields, file.format === 'json');
    if (new Set(fields.map((field) => field.name)).size !== fields.length) return fail();
    if (file.template !== undefined) {
      if (
        file.format !== 'json' ||
        typeof file.template !== 'string' ||
        file.template.length > 64000
      )
        return fail();
      try {
        const template: unknown = JSON.parse(file.template, (key, value: unknown) => {
          if (['__proto__', 'constructor', 'prototype'].includes(key)) return fail();
          return value;
        });
        if (!template || typeof template !== 'object' || Array.isArray(template)) return fail();
        for (const field of fields.filter((field) => field.secret !== false)) {
          let content: unknown = template;
          for (const part of field.name.split('.')) {
            content =
              content && typeof content === 'object'
                ? (content as Record<string, unknown>)[part]
                : undefined;
          }
          if (content !== undefined && content !== null && content !== '') return fail();
        }
      } catch {
        return fail();
      }
    }
    return {
      path: file.path,
      ...(file.format ? { format: file.format as 'json' | 'env' | 'text' } : {}),
      ...(file.template !== undefined ? { template: file.template as string } : {}),
      ...(fields.length ? { fields } : {}),
      label: text(file.label),
      description: text(file.description),
      ...(file.directory ? { directory: true } : {}),
    };
  });
  const managed = entries(input.managed).map((field) => {
    if (
      Object.keys(field).some(
        (key) => !['name', 'source', 'description', 'default'].includes(key),
      ) ||
      typeof field.name !== 'string' ||
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/.test(field.name) ||
      typeof field.source !== 'string' ||
      !['task', 'generated', 'default'].includes(field.source) ||
      typeof field.description !== 'string'
    )
      return fail();
    return {
      name: field.name,
      source: field.source as 'task' | 'generated' | 'default',
      description: text(field.description)!,
      ...(field.default !== undefined ? { default: text(field.default) } : {}),
    };
  });
  if (
    new Set(values.map((field) => field.name)).size !== values.length ||
    new Set(files.map((file) => file.path)).size !== files.length
  )
    return fail();
  return values.length || files.length || managed.length
    ? { enabled: input.enabled === true, values, files, ...(managed.length ? { managed } : {}) }
    : undefined;
}
