import { githubTaskAccount } from '../services/githubPoolService.js';
import { withToolAudit } from '../services/toolAuditService.js';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { getServerDao } from '../dao/DaoFactory.js';
import { accessWorkspaceRun, WorkspaceError } from '../services/workspaceService.js';
import { canUseWorkspace } from './workspaceController.js';
import { getUserGroupPolicy, userGroupAllows } from '../services/userGroupService.js';
import { githubPreparation } from '../services/githubPreparationService.js';
import { githubThrottleStore } from '../services/githubThrottleStore.js';
import { githubRequestScheduler } from '../services/githubRequestSchedulerService.js';
import { requestHttpUpstream } from '../services/httpForwardService.js';
import { workspaceHttpSecret } from '../utils/workspaceHttp.js';
import { decodedHttpPreview } from '../utils/httpResponseBody.js';
import { upstreamCredential } from '../utils/upstreamCredential.js';

type Caller = Request & {
  user?: { username: string; isAdmin: boolean; credentialEligible?: boolean };
  bearerKey?: { id: string; userGroupId?: string };
};
export async function githubPreparationSlot(req: Caller, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const abort = new AbortController();
  const disconnect = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on('close', disconnect);
  try {
    if (!req.user || req.get('X-MCPHub-Stage') !== 'prepare')
      throw new WorkspaceError('Preparation access denied', 403);
    const task = req.get('X-MCPHub-Task-Id') || '';
    const holder = req.get('X-MCPHub-Preparation-Id') || '';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task) || !/^[a-f0-9]{32}$/.test(holder))
      throw new WorkspaceError('Invalid preparation scope');
    const { run, workspace } = await accessWorkspaceRun(
      String(req.params.id),
      req.get('X-MCPHub-Run-Token') || '',
      req.bearerKey?.id || `user:${req.user.username}`,
      (config) => canUseWorkspace(req, config),
    );
    const server = `${run.catalog}::github`;
    const definition = await getServerDao().findById(server);
    const policy = await getUserGroupPolicy(req.user, req.bearerKey?.id);
    const allowed = definition?.targets?.length
      ? definition.targets.some(
          (t) =>
            t.kind === 'task' && t.enabled !== false && userGroupAllows(policy, server, t.path),
        )
      : userGroupAllows(policy, server);
    const binding = definition?.workspaceSchema?.http?.find(
      (b) => b.id === 'api' && new URL(b.url).hostname === 'api.github.com',
    );
    if (
      !allowed ||
      !definition ||
      definition.enabled === false ||
      !definition.workspaceSchema?.enabled ||
      !binding
    )
      throw new WorkspaceError('GitHub account access denied', 403);
    let secret = workspaceHttpSecret(binding, workspace);
    if (run.githubPool?.accounts.length) {
      try {
        secret = (await githubTaskAccount(run.id, task, req.get('X-MCPHub-Github-Lease') || ''))
          .token;
      } catch {
        throw new WorkspaceError('GitHub task lease unavailable', 409);
      }
    }
    if (!secret) throw new WorkspaceError('GitHub credential unavailable', 409);
    const key = createHash('sha256').update(secret).digest('hex');
    let account = await githubThrottleStore.identity(key);
    if (!account) {
      if (req.method === 'DELETE')
        throw new WorkspaceError('Preparation identity unavailable', 409);
      const identify = (signal: AbortSignal) =>
        withToolAudit(
          {
            server,
            tool: 'GitHub preparation identity',
            target: run.workspace,
            taskId: task,
            phase: 'prepare',
            username: req.user!.username,
            keyId: req.bearerKey?.id,
            sourceIp: req.ip,
          },
          () =>
            requestHttpUpstream(
              {
                ...definition,
                headers: {
                  authorization: `Bearer ${secret}`,
                  accept: 'application/vnd.github+json',
                },
                options: { ...definition.options, timeout: 15000 },
              },
              'https://api.github.com/user',
              'GET',
              undefined,
              {},
              signal,
              false,
              1024 * 1024,
              [upstreamCredential(secret, 'github_token')],
            ),
        );
      const result = await githubRequestScheduler.run({
        credential: secret,
        url: 'https://api.github.com/user',
        method: 'GET',
        signal: abort.signal,
        identify,
        dispatch: () => identify(abort.signal),
      });
      if (result.status !== 200) {
        if (result.headers['retry-after'])
          res.setHeader('Retry-After', result.headers['retry-after']);
        res
          .status(result.status)
          .json({ success: false, error: 'GitHub preparation identity unavailable' });
        return;
      }
      const identity = JSON.parse(
        decodedHttpPreview(result.body, result.headers['content-encoding']).toString(),
      );
      if (!Number.isSafeInteger(identity.id) || identity.id <= 0)
        throw new Error('Invalid GitHub identity');
      account = String(identity.id);
      await githubThrottleStore.saveIdentity(key, account);
    }
    if (req.method === 'POST') {
      const state = await githubThrottleStore.load(account);
      const wait = (state?.cooldownUntil || 0) - Date.now();
      if (wait > 0) {
        res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
        res.status(429).json({ success: false, error: 'GitHub account is cooling down' });
        return;
      }
    }
    const granted = await githubPreparation(
      account,
      { run: run.id, task, holder },
      req.method === 'DELETE',
      async () => {
        abort.signal.throwIfAborted();
        const access = await accessWorkspaceRun(
          run.id,
          req.get('X-MCPHub-Run-Token') || '',
          req.bearerKey?.id || `user:${req.user!.username}`,
          (config) => canUseWorkspace(req, config),
        );
        // The pool lease may have been released while this request waited for
        // the preparation lock. Never recreate an initializer for a retired task.
        if (run.githubPool?.accounts.length) {
          try {
            await githubTaskAccount(run.id, task, req.get('X-MCPHub-Github-Lease') || '');
          } catch {
            throw new WorkspaceError('GitHub task lease unavailable', 409);
          }
        }
        return access;
      },
    );
    if (!granted) res.setHeader('Retry-After', '5');
    res
      .status(granted ? 200 : 409)
      .json({ success: granted, error: granted ? undefined : 'GitHub preparation is occupied' });
  } catch (error) {
    res.status(error instanceof WorkspaceError ? error.status : 503).json({
      success: false,
      error: error instanceof WorkspaceError ? error.message : 'GitHub preparation unavailable',
    });
  } finally {
    res.off('close', disconnect);
  }
}
