import { getUserGroupPolicy, userGroupAllows } from '../services/userGroupService.js';
import type { Request, Response } from 'express';
import { getServerDao } from '../dao/DaoFactory.js';
import { requireAdmin } from '../utils/requireAdmin.js';
import { authorizeTargetForCaller } from '../services/targetRuntimeService.js';
import { supportsFetchRelay } from '../utils/relayCompatibility.js';
import { expandServerConfig } from '../services/serverConfigEnvironment.js';
import { getRelayEnvironment } from '../services/atlasConfigService.js';
/** Scoped worker setup; provider values require an explicit task-target allowlist. */
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
  const policy = await getUserGroupPolicy(identity.user, identity.bearerKey?.id);
  if (
    !userGroupAllows(policy, server, path) ||
    !definition ||
    definition.enabled === false ||
    (definition.targets?.length &&
      (!target ||
        !(await authorizeTargetForCaller(server, target, identity.user, identity.bearerKey?.id))))
  ) {
    res.status(403).json({ success: false, message: 'Connection not available' });
    return;
  }
  try {
    const expanded =
      target?.kind === 'task' && target.startupEnvKeys?.length
        ? await expandServerConfig(definition)
        : undefined;
    const startupEnv = Object.fromEntries(
      (target?.kind === 'task' ? (target.startupEnvKeys ?? []) : []).flatMap((name) => {
        const value = expanded?.env?.[name];
        return typeof value === 'string' ? [[name, value]] : [];
      }),
    );
    res.json({
      success: true,
      data: {
        ...(target?.kind === 'task' ? { startupEnv } : {}),
        env: await getRelayEnvironment(
          server,
          target?.config?.relay ?? definition.relay,
          supportsFetchRelay(target?.config ?? definition),
        ),
      },
    });
  } catch {
    res.status(503).json({ success: false, message: 'Connection runtime unavailable' });
  }
}
