import { splitServerKey } from '../utils/catalog.js';

export interface RuntimeWorker {
  id: string;
  catalog: string;
  url: string;
  token: string;
  servers?: string[];
  targets?: Record<string, string[]>;
}

/** Operator-only deployment configuration. Never expose tokens in API responses. */
export function runtimeWorkers(): RuntimeWorker[] {
  const raw: unknown = JSON.parse(process.env.MCPHUB_WORKERS || '{}');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid MCPHUB_WORKERS');
  return Object.entries(raw).map(([id, value]) => {
    const worker = value as Record<string, unknown>;
    if (
      !worker ||
      typeof worker !== 'object' ||
      !/^[a-z][a-z0-9_-]{0,47}$/.test(id) ||
      typeof worker.catalog !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,47}$/.test(worker.catalog) ||
      typeof worker.url !== 'string' ||
      typeof worker.token !== 'string' ||
      worker.token.length < 32
    )
      throw new Error('Invalid runtime worker definition');
    const url = new URL(worker.url);
    if (
      !['ws:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        'Runtime workers require a private WS(S) endpoint without credentials in the URL',
      );
    if (
      worker.servers !== undefined &&
      (!Array.isArray(worker.servers) ||
        !worker.servers.length ||
        worker.servers.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name)))
    )
      throw new Error('Invalid runtime worker server selection');
    if (
      worker.targets !== undefined &&
      (!worker.targets ||
        typeof worker.targets !== 'object' ||
        Array.isArray(worker.targets) ||
        Object.entries(worker.targets).some(
          ([name, paths]) =>
            !/^[A-Za-z0-9_.-]+$/.test(name) ||
            !Array.isArray(paths) ||
            !paths.length ||
            paths.some((p) => typeof p !== 'string' || !p || p.length > 160),
        ))
    )
      throw new Error('Invalid worker target selection');
    return {
      id,
      catalog: worker.catalog,
      url: url.toString(),
      token: worker.token,
      ...(worker.servers ? { servers: worker.servers as string[] } : {}),
      ...(worker.targets ? { targets: worker.targets as Record<string, string[]> } : {}),
    };
  });
}

/** Exact server assignments override the catalog default; never select another catalog. */
export function runtimeWorkerFor(name: string, target?: string): RuntimeWorker | undefined {
  const identity = splitServerKey(name);
  if (!identity.catalog) return;
  const candidates = runtimeWorkers().filter((worker) => worker.catalog === identity.catalog);
  const exact = candidates.filter((worker) => worker.servers?.includes(identity.name));
  const targeted = candidates.filter(
    (worker) => target && worker.targets?.[identity.name]?.includes(target),
  );
  const selected = targeted.length
    ? targeted
    : exact.length
      ? exact
      : candidates.filter((worker) => !worker.servers && !worker.targets);
  if (selected.length > 1) throw new Error('Ambiguous runtime worker assignment');
  if (!selected.length && process.env.MCPHUB_REQUIRE_WORKERS === 'true')
    throw new Error(`No runtime worker assigned to catalog ${identity.catalog}`);
  return selected[0];
}

/** A worker receives toolchain settings and this connection's credentials, not Hub secrets. */
export function workerEnvironment(
  expanded: Record<string, string>,
  explicit: Record<string, string> | null = {},
): Record<string, string> {
  const toolchain = new Set([
    'PATH',
    'LANG',
    'LC_ALL',
    'TZ',
    'NODE_OPTIONS',
    'PYTHONPATH',
    'SLACK_MCP_CHANNELS_CACHE',
    'SLACK_MCP_USERS_CACHE',
    'PYTHONUNBUFFERED',
    'UV_DEFAULT_INDEX',
    'npm_config_registry',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ]);
  return Object.fromEntries(
    Object.entries(expanded).filter(
      ([key]) =>
        (key in (explicit || {}) ||
          toolchain.has(key) ||
          key.startsWith('MCP_RELAY_') ||
          key.startsWith('MCPHUB_KEY_POOL_') ||
          key.startsWith('MCP_USAGE_LOG_') ||
          key.startsWith('MCPHUB_CONNECTION_') ||
          key === 'MCPHUB_TWELVEDATA_COMPAT') &&
        ![
          'MCPHUB_WORKERS',
          'MCPHUB_CREDENTIAL_ENCRYPTION_KEY',
          'JWT_SECRET',
          'DB_URL',
          'POSTGRES_PASSWORD',
          'ADMIN_PASSWORD',
        ].includes(key),
    ),
  );
}
