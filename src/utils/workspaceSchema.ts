import type {
  WorkspaceCredentialField,
  WorkspaceCredentialSchema,
  WorkspaceHttpBinding,
} from '../types/workspace.js';

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
  if (
    Object.keys(input).some(
      (key) => !['enabled', 'connection', 'values', 'files', 'managed', 'http'].includes(key),
    )
  )
    return fail();
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return fail();
  if (input.connection !== undefined && typeof input.connection !== 'boolean') return fail();
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
            ![
              'name',
              'label',
              'description',
              'secret',
              'env',
              'multiline',
              'default',
              'required',
            ].includes(key),
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
        (field.required !== undefined && typeof field.required !== 'boolean') ||
        (field.secret !== undefined && typeof field.secret !== 'boolean') ||
        (field.multiline !== undefined && typeof field.multiline !== 'boolean') ||
        (field.default !== undefined &&
          (field.secret !== false || typeof field.default !== 'string'))
      )
        return fail();
      return {
        name: field.name,
        ...(field.required !== undefined ? { required: field.required as boolean } : {}),
        label: text(field.label),
        description: text(field.description),
        secret: field.secret !== false,
        ...(field.multiline ? { multiline: true } : {}),
        ...(field.default !== undefined ? { default: text(field.default) } : {}),
        ...(field.env ? { env: field.env as string } : {}),
      };
    });
  const values = parseFields(input.values);
  const http: WorkspaceHttpBinding[] = entries(input.http).map((binding) => {
    if (
      Object.keys(binding).some(
        (key) =>
          ![
            'id',
            'url',
            'credential',
            'headers',
            'protocol',
            'responseError',
            'streaming',
            'egress',
            'assetHosts',
          ].includes(key),
      ) ||
      (binding.protocol !== undefined && !['http', 'grpc'].includes(String(binding.protocol))) ||
      typeof binding.id !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,47}$/.test(binding.id) ||
      typeof binding.url !== 'string'
    )
      return fail();
    if (
      binding.streaming !== undefined &&
      (typeof binding.streaming !== 'boolean' || (binding.streaming && binding.protocol === 'grpc'))
    )
      return fail();
    if (
      binding.egress !== undefined &&
      (binding.egress !== 'ip-pool' || binding.protocol === 'grpc')
    )
      return fail();
    let url: URL;
    if (
      binding.assetHosts !== undefined &&
      (!Array.isArray(binding.assetHosts) ||
        !binding.assetHosts.length ||
        binding.assetHosts.length > 32 ||
        !binding.streaming ||
        binding.assetHosts.some(
          (host) =>
            typeof host !== 'string' ||
            host.length > 200 ||
            !/^(?:[A-Za-z0-9*-]+\.)+[A-Za-z]{2,}$/.test(host),
        ))
    )
      return fail();
    try {
      const template = binding.url.replace(
        /\$\{([A-Za-z][A-Za-z0-9_]*)\}/g,
        (_match, name: string) => {
          if (!values.some((field) => field.name === name && field.secret === false)) return fail();
          return 'account';
        },
      );
      url = new URL(template);
    } catch {
      return fail();
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return fail();
    const auth = binding.credential as Record<string, unknown> | undefined;
    if (
      !auth ||
      typeof auth !== 'object' ||
      Array.isArray(auth) ||
      Object.keys(auth).some(
        (key) =>
          !['value', 'file', 'field', 'forward', 'header', 'prefix', 'username'].includes(key),
      ) ||
      (auth.forward !== undefined && auth.forward !== true) ||
      (auth.forward === true
        ? auth.value !== undefined ||
          typeof auth.file !== 'string' ||
          auth.prefix !== undefined ||
          auth.username !== undefined ||
          auth.header !== 'Authorization' ||
          !entries(input.files).some(
            (file) =>
              file.path === auth.file &&
              (file.format === 'text'
                ? auth.field === undefined
                : file.format === 'json' &&
                  typeof auth.field === 'string' &&
                  parseFields(file.fields, true).some(
                    (field) => field.name === auth.field && field.secret,
                  )),
          )
        : typeof auth.value !== 'string' ||
          auth.file !== undefined ||
          auth.field !== undefined ||
          !values.some((field) => field.name === auth.value && field.secret)) ||
      typeof auth.header !== 'string' ||
      !/^[A-Za-z0-9-]{1,100}$/.test(auth.header) ||
      ['host', 'content-length', 'connection', 'transfer-encoding', 'cookie'].includes(
        auth.header.toLowerCase(),
      ) ||
      (auth.prefix !== undefined &&
        (typeof auth.prefix !== 'string' || /[\r\n]/.test(auth.prefix))) ||
      (auth.username !== undefined &&
        (typeof auth.username !== 'string' || /[:\r\n]/.test(auth.username)))
    )
      return fail();
    const headers = binding.headers ?? {};
    if (
      !headers ||
      typeof headers !== 'object' ||
      Array.isArray(headers) ||
      Object.entries(headers).some(
        ([name, value]) =>
          !['accept', 'content-type', 'x-github-api-version', 'notion-version'].includes(
            name.toLowerCase(),
          ) ||
          typeof value !== 'string' ||
          value.length > 1000 ||
          /[\r\n]/.test(value),
      )
    )
      return fail();
    const responseError = binding.responseError as Record<string, unknown> | undefined;
    if (
      responseError !== undefined &&
      (!responseError ||
        Array.isArray(responseError) ||
        Object.keys(responseError).some((key) => !['field', 'mode'].includes(key)) ||
        typeof responseError.field !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_.]{0,99}$/.test(responseError.field) ||
        responseError.field
          .split('.')
          .some((part) => ['__proto__', 'constructor', 'prototype', ''].includes(part)) ||
        !['false', 'nonempty-array'].includes(String(responseError.mode)))
    )
      return fail();
    return {
      id: binding.id,
      url: binding.url,
      ...(binding.protocol === 'grpc' ? { protocol: 'grpc' as const } : {}),
      ...(binding.streaming ? { streaming: true } : {}),
      ...(binding.egress === 'ip-pool' ? { egress: 'ip-pool' as const } : {}),
      ...(binding.assetHosts ? { assetHosts: binding.assetHosts as string[] } : {}),
      ...(responseError
        ? { responseError: responseError as unknown as WorkspaceHttpBinding['responseError'] }
        : {}),
      credential: {
        ...(auth.value ? { value: auth.value as string } : {}),
        ...(auth.file ? { file: auth.file as string } : {}),
        ...(auth.field ? { field: auth.field as string } : {}),
        ...(auth.forward ? { forward: true } : {}),
        header: auth.header,
        ...(auth.prefix !== undefined ? { prefix: auth.prefix as string } : {}),
        ...(auth.username !== undefined ? { username: auth.username as string } : {}),
      },
      headers: headers as Record<string, string>,
    };
  });
  if (new Set(http.map((binding) => binding.id)).size !== http.length) return fail();
  const files = entries(input.files).map((file) => {
    if (
      Object.keys(file).some(
        (key) =>
          ![
            'path',
            'label',
            'description',
            'directory',
            'format',
            'template',
            'fields',
            'required',
          ].includes(key),
      ) ||
      typeof file.path !== 'string' ||
      (file.required !== undefined && typeof file.required !== 'boolean') ||
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
      ...(file.required !== undefined ? { required: file.required as boolean } : {}),
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
  return values.length || files.length || managed.length || input.connection
    ? {
        enabled: input.enabled === true,
        ...(input.connection ? { connection: true } : {}),
        values,
        files,
        ...(managed.length ? { managed } : {}),
        ...(http.length ? { http } : {}),
      }
    : undefined;
}
