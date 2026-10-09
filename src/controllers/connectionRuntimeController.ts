import type { Request, Response } from 'express';
import { getServerDao } from '../dao/DaoFactory.js';
import { requireAdmin } from '../utils/requireAdmin.js';
import { authorizeTarget } from '../services/targetRuntimeService.js';
import { getRelayEnvironment } from '../services/atlasConfigService.js';
/** Credentials for compatible task adapters, never MCP-provider keys. */
export async function connectionRuntime(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  const identity = req as Request & {
    user?: { username: string; isAdmin: boolean };
    bearerKey?: { id: string };
  };
  const server = String(req.params.name);
  const definition = await getServerDao().findById(server);
  const path = typeof req.query.target === 'string' ? req.query.target : undefined;
  const target = definition?.targets?.find((value) => value.path === path);
  if (
    !definition ||
    definition.enabled === false ||
    (definition.targets?.length &&
      (!target || !authorizeTarget(target, identity.user, identity.bearerKey?.id)))
  ) {
    res.status(403).json({ success: false, message: 'Connection not available' });
    return;
  }
  try {
    res.json({
      success: true,
      data: { env: await getRelayEnvironment(server, target?.config?.relay ?? definition.relay) },
    });
  } catch {
    res.status(503).json({ success: false, message: 'Connection runtime unavailable' });
  }
}
