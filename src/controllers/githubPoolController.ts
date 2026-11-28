import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { getServerDao } from '../dao/DaoFactory.js';
import { accessWorkspaceRun, WorkspaceError } from '../services/workspaceService.js';
import { canUseWorkspace } from './workspaceController.js';
import { getUserGroupPolicy, userGroupAllows } from '../services/userGroupService.js';
import {
  acquireGithubTask,
  releaseGithubTask,
  githubPoolSnapshot,
  saveGithubPool,
} from '../services/githubPoolService.js';
import { githubThrottleStore } from '../services/githubThrottleStore.js';
import { requestHttpUpstream } from '../services/httpForwardService.js';
import { withToolAudit } from '../services/toolAuditService.js';
import { upstreamCredential } from '../utils/upstreamCredential.js';
import { decodedHttpPreview } from '../utils/httpResponseBody.js';
import type { GithubPoolAccount } from '../types/githubPool.js';

type Caller = Request & {
  user?: { username: string; isAdmin: boolean; credentialEligible?: boolean };
  bearerKey?: { id: string; userGroupId?: string };
};
function failure(res: Response, error: unknown) {
  res.status(error instanceof WorkspaceError ? error.status : 503).json({
    success: false,
    error: error instanceof WorkspaceError ? error.message : 'GitHub pool operation unavailable',
  });
}
export async function githubPoolManagement(req: Caller, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.user?.isAdmin || req.bearerKey || req.user.credentialEligible === false) {
    res.status(403).json({ success: false });
    return;
  }
  try {
    const catalog = String(req.params.catalog);
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(catalog)) throw new WorkspaceError('Invalid catalog');
    if (req.method === 'GET') {
      const pool = await githubPoolSnapshot(catalog);
      res.json({
        success: true,
        data: {
          enabled: !!pool?.accounts.length,
          revision: pool?.revision,
          accounts: pool?.accounts.map(({ id, login }) => ({ id, login })) || [],
        },
      });
      return;
    }
    const tokens: unknown = req.body?.tokens;
    if (
      !Array.isArray(tokens) ||
      tokens.length > 50 ||
      tokens.some((t) => typeof t !== 'string' || !t || /\s/.test(t))
    )
      throw new WorkspaceError('Expected at most 50 GitHub tokens');
    const server = `${catalog}::github`;
    const definition = await getServerDao().findById(server);
    if (!definition?.workspaceSchema?.enabled)
      throw new WorkspaceError('GitHub workspace binding unavailable', 409);
    const accounts: GithubPoolAccount[] = [];
    for (const token of tokens as string[]) {
      const result = await withToolAudit(
        { server, tool: 'GitHub pool identity', username: req.user.username },
        () =>
          requestHttpUpstream(
            {
              ...definition,
              headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
              options: { ...definition.options, timeout: 15000 },
            },
            'https://api.github.com/user',
            'GET',
            undefined,
            {},
            AbortSignal.timeout(15000),
            false,
            1024 * 1024,
            [upstreamCredential(token, 'github_token')],
          ),
      );
      if (result.status !== 200)
        throw new WorkspaceError('GitHub token identity verification failed', 422);
      const value = JSON.parse(
        decodedHttpPreview(result.body, result.headers['content-encoding']).toString(),
      );
      if (!Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.login !== 'string')
        throw new WorkspaceError('Invalid GitHub identity', 422);
      if (accounts.some((a) => a.id === String(value.id)))
        throw new WorkspaceError('Multiple tokens belong to the same GitHub account', 422);
      accounts.push({ id: String(value.id), login: value.login, token });
      await githubThrottleStore.saveIdentity(
        createHash('sha256').update(token).digest('hex'),
        String(value.id),
      );
    }
    await saveGithubPool(catalog, accounts);
    res.json({
      success: true,
      data: { accounts: accounts.map(({ id, login }) => ({ id, login })) },
    });
  } catch (error) {
    failure(res, error);
  }
}
export async function githubTaskLease(req: Caller, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!req.user || req.get('X-MCPHub-Stage') !== 'prepare')
      throw new WorkspaceError('GitHub lease access denied', 403);
    const task = req.get('X-MCPHub-Task-Id') || '';
    const holder = req.get('X-MCPHub-Github-Lease') || '';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task) || !/^[a-f0-9]{32}$/.test(holder))
      throw new WorkspaceError('Invalid GitHub task scope');
    const access = () =>
      accessWorkspaceRun(
        String(req.params.id),
        req.get('X-MCPHub-Run-Token') || '',
        req.bearerKey?.id || `user:${req.user!.username}`,
        (config) => canUseWorkspace(req, config),
      );
    const { run } = await access();
    const server = `${run.catalog}::github`;
    const definition = await getServerDao().findById(server);
    const policy = await getUserGroupPolicy(req.user, req.bearerKey?.id);
    const allowed = definition?.targets?.length
      ? definition.targets.some(
          (t) =>
            t.kind === 'task' && t.enabled !== false && userGroupAllows(policy, server, t.path),
        )
      : userGroupAllows(policy, server);
    if (!allowed || definition?.enabled === false || !definition?.workspaceSchema?.enabled)
      throw new WorkspaceError('GitHub account access denied', 403);
    if (!run.githubPool?.accounts.length) {
      res.json({ success: true, data: { enabled: false } });
      return;
    }
    if (req.method === 'DELETE') {
      await releaseGithubTask(run.id, task, holder, access);
      res.json({ success: true });
      return;
    }
    const lease = await acquireGithubTask(run.githubPool, run.id, task, holder, access);
    if (!lease) {
      res.setHeader('Retry-After', '5');
      res
        .status(409)
        .json({ success: false, error: 'GitHub pool accounts occupied or cooling down' });
      return;
    }
    res.json({
      success: true,
      data: {
        enabled: true,
        id: lease.account.id,
        login: lease.account.login,
        revision: run.githubPool.revision,
      },
    });
  } catch (error) {
    failure(res, error);
  }
}
