import { CredentialBindingError } from '../utils/credentialTemplate.js';
import { logger } from '../utils/logger.js';
import type { Request, Response } from 'express';
import { getServerDao, getBearerKeyDao, getUserDao } from '../dao/DaoFactory.js';
import { requireAdmin } from '../utils/requireAdmin.js';
import {
  getAtlasConfig,
  AtlasConfigValidationError,
  validateAtlasConfig,
  saveAtlasConfig,
  hasRelayToken,
  getRelayEnvironment,
  RELAY_SERVERS,
  BASE_POLICY,
} from '../services/atlasConfigService.js';
import { toolCallScheduler } from '../services/toolCallSchedulerService.js';
import { closeServer, initializeClientsFromSettings } from '../services/mcpService.js';
import { assertSafeUrl } from '../utils/ssrf.js';
import { relayRuntimeService } from '../services/relayRuntimeService.js';
import { supportsFetchRelay } from '../utils/relayCompatibility.js';

export async function getAtlasSettings(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  const config = await getAtlasConfig();
  const servers = await getServerDao().findAll();
  const serverRelay = Object.fromEntries(
    servers.flatMap((server) => {
      if (server.targets?.length) {
        const targets = server.targets.filter(
          (target) =>
            target.enabled !== false &&
            supportsFetchRelay(target.config ?? {}) &&
            target.config?.relay?.enabled !== false,
        );
        return targets.length
          ? [[server.name, targets.every((target) => target.kind === 'task') ? 'task' : 'enabled']]
          : [];
      }
      return supportsFetchRelay(server) && server.relay?.enabled !== false
        ? [[server.name, 'enabled']]
        : [];
    }),
  );
  res.json({
    success: true,
    data: {
      ...config,
      hasRelayToken: await hasRelayToken(),
      basePolicy: BASE_POLICY,
      stats: toolCallScheduler.stats(),
      servers: servers.map((s) => s.name),
      serverRelay,
    },
  });
}

export async function updateAtlasSettings(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  const old = await getAtlasConfig();
  if (
    (req.body.relayToken || req.body.clearRelayToken) &&
    (await relayRuntimeService.status()).state === 'running'
  ) {
    res.status(409).json({ success: false, message: 'Use Reset Token for a running Hub relay' });
    return;
  }
  try {
    await saveAtlasConfig(req.body.config, req.body.relayToken, req.body.clearRelayToken === true);
  } catch (error) {
    const expected =
      error instanceof AtlasConfigValidationError || error instanceof CredentialBindingError;
    if (!expected)
      logger.error('Unable to save Relay settings', {
        category: error instanceof Error ? error.name : 'unknown',
      });
    res.status(expected ? 400 : 500).json({
      success: false,
      message: expected
        ? error.message
        : 'Unable to persist Relay settings; check the Hub server logs',
    });
    return;
  }
  const current = await getAtlasConfig();
  const relayChanged =
    JSON.stringify(old.relay) !== JSON.stringify(current.relay) ||
    Boolean(req.body.relayToken) ||
    req.body.clearRelayToken === true;
  const failed = relayChanged ? await reconnectRelayServers() : [];
  const persisted = await getAtlasConfig();
  const tokenConfigured = await hasRelayToken();
  if (
    JSON.stringify(persisted.relay) !== JSON.stringify(current.relay) ||
    (current.relay.enabled && !tokenConfigured)
  ) {
    res.status(409).json({
      success: false,
      message:
        'Relay settings were not retained after reconnecting. Reload this page and save again',
    });
    return;
  }
  logger.info('Relay settings saved and verified', {
    enabled: persisted.relay.enabled,
    tokenConfigured,
  });
  res.json({ success: true, data: { reconnectFailed: failed } });
}

/** Only Hub-owned static connections reload; active task workers retain their snapshots. */
export async function reconnectRelayServers(): Promise<string[]> {
  const failed: string[] = [];
  for (const server of await getServerDao().findAll()) {
    const compatible = server.targets?.length
      ? server.targets.some(
          (target) => target.kind === 'static' && supportsFetchRelay(target.config ?? {}),
        )
      : supportsFetchRelay(server);
    if (server.enabled === false || !compatible) continue;
    try {
      closeServer(server.name);
      await initializeClientsFromSettings(false, server.name);
    } catch {
      failed.push(server.name);
    }
  }
  return failed;
}

export async function checkAtlasRelay(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { relay } = req.body?.config
      ? validateAtlasConfig(req.body.config)
      : await getAtlasConfig();
    if (!relay.enabled)
      throw new AtlasConfigValidationError(
        'Enable Relay forwarding before checking the connection',
      );
    const url = `${relay.url}/health`;
    await assertSafeUrl(url, { allowInternal: true });
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const health = (await response.json().catch(() => null)) as { status?: string } | null;
    if (!health || !['ok', 'blocked'].includes(health.status || '')) {
      res.status(400).json({
        success: false,
        message:
          'This address is not a Relay health endpoint. Use the Relay service port, not the MCPHub dashboard port',
      });
      return;
    }
    res.status(response.ok ? 200 : 502).json({
      success: response.ok,
      ...(response.ok
        ? {}
        : {
            message: 'Relay is reachable but reports unhealthy; check the external Relay service',
          }),
      data: { reachable: true, httpStatus: response.status },
    });
  } catch (error) {
    res.status(error instanceof AtlasConfigValidationError ? 400 : 502).json({
      success: false,
      message:
        error instanceof AtlasConfigValidationError ? error.message : 'Relay health check failed',
    });
  }
}

/** Existing operator Bearer Keys can delegate only relay settings to task creation. */
export async function getAtlasRelayRuntime(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const authorization = req.header('authorization') || '';
  const key = authorization.startsWith('Bearer ')
    ? await getBearerKeyDao().findByToken(authorization.slice(7))
    : undefined;
  const server = typeof req.query.server === 'string' ? req.query.server : '';
  const owner =
    key?.kind === 'user' && key.owner ? await getUserDao().findByUsername(key.owner) : undefined;
  const trusted =
    key && key.enabled && ((key.kind ?? 'system') === 'system' || owner?.isAdmin === true);
  const scoped =
    key?.accessType === 'all' ||
    ((key?.accessType === 'servers' || key?.accessType === 'custom') &&
      key.allowedServers?.includes(server));
  if (!trusted || !scoped || !RELAY_SERVERS.has(server)) {
    res.status(403).json({ success: false, message: 'Relay access denied' });
    return;
  }
  try {
    res.json({ success: true, data: await getRelayEnvironment(server) });
  } catch {
    res.status(503).json({ success: false, message: 'Relay configuration unavailable' });
  }
}

/** Relay rate controls remain at the HTTP layer; Hub never retries an MCP operation. */
export async function relayLimits(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const environment = await getRelayEnvironment('pubmed');
    const url = environment.MCP_RELAY_URL;
    const token = environment.MCP_RELAY_TOKEN;
    if (!url || !token) {
      res
        .status(409)
        .json({ success: false, message: 'Configure and enable the managed relay first' });
      return;
    }
    await assertSafeUrl(`${url}/v1/limits`, { allowInternal: true });
    const response = await fetch(`${url}/v1/limits`, {
      method: req.method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(req.method === 'PUT' ? { body: JSON.stringify({ limits: req.body.limits }) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      res.status(response.status === 400 ? 400 : 502).json({
        success: false,
        message: 'Relay rejected the rate settings or does not support live limits',
        httpStatus: response.status,
      });
      return;
    }
    const data = (await response.json()) as { limits?: unknown };
    res.json({ success: true, data: { limits: data.limits } });
  } catch {
    res.status(502).json({ success: false, message: 'Relay rate configuration unavailable' });
  }
}
