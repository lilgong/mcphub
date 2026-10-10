import { getUserGroupPolicy, userGroupAllows } from '../services/userGroupService.js';
import type { Request, Response } from 'express';
import { getServerDao, getBearerKeyDao } from '../dao/DaoFactory.js';
import { taskConnections } from '../services/taskConnectionService.js';
import { authorizeTargetForCaller } from '../services/targetRuntimeService.js';
import { assertSafeUrl } from '../utils/ssrf.js';
import { requireAdmin } from '../utils/requireAdmin.js';
import { withToolAudit } from '../services/toolAuditService.js';
import { toolCallScheduler } from '../services/toolCallSchedulerService.js';
import { RequestContextService } from '../services/requestContextService.js';
const owner = (req: Request): string => {
  const principal = req as Request & { user?: { username: string }; bearerKey?: { id: string } };
  return principal.bearerKey?.id || principal.user?.username || '';
};
export async function registerTaskConnection(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { server, target, taskId, url, token } = req.body ?? {};
    if (
      [server, target, taskId, url, token].some(
        (value) => typeof value !== 'string' || !value || value.length > 2048,
      ) ||
      !/^[A-Za-z0-9_.:-]{1,160}$/.test(taskId)
    )
      throw new Error('Invalid registration');
    const definition = await getServerDao().findById(server);
    const connection = definition?.targets?.find(
      (entry) => entry.path === target && entry.kind === 'task',
    );
    const identity = req as Request & {
      user?: { username: string; isAdmin: boolean };
      bearerKey?: { id: string };
    };
    if (
      !definition ||
      definition.enabled === false ||
      !connection ||
      !(await authorizeTargetForCaller(server, connection, identity.user, identity.bearerKey?.id))
    ) {
      res.status(403).json({ success: false, message: 'Task target not available' });
      return;
    }
    await assertSafeUrl(url, { allowInternal: true });
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error('Invalid callback URL');
    const entry = taskConnections.register({
      server,
      target,
      taskId,
      url: url.replace(/\/$/, ''),
      upstreamToken: token,
      owner: owner(req),
      username: identity.user!.username,
      keyId: identity.bearerKey?.id,
      implementation: connection.implementation,
      configuredVersion: connection.version,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: {
        id: entry.id,
        token: entry.token,
        expiresAt: entry.expiresAt,
        path: `/gateway/v1/tasks/${entry.id}`,
      },
    });
  } catch {
    res
      .status(400)
      .json({ success: false, message: 'Invalid or duplicate task connection registration' });
  }
}
export async function renewTaskConnection(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  const resource = taskConnections.getOwnedResource(String(req.params.id), owner(req));
  const keyId = (req as Request & { bearerKey?: { id: string } }).bearerKey?.id;
  const policy = await getUserGroupPolicy(null, keyId);
  if (!resource || !userGroupAllows(policy, resource.server, resource.target)) {
    res.status(403).json({ success: false, message: 'Task target not available' });
    return;
  }
  const success = taskConnections.renew(String(req.params.id), owner(req));
  res.status(success ? 200 : 404).json({ success });
}
export async function removeTaskConnection(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  const success = taskConnections.remove(String(req.params.id), owner(req));
  res.status(success ? 200 : 404).json({ success });
}
export async function dispatchTaskConnection(req: Request, res: Response): Promise<void> {
  const token = req.get('authorization')?.replace(/^Bearer /, '') || '';
  const entry = taskConnections.acquire(String(req.params.id), token);
  if (!entry) {
    res.status(403).json({ message: 'Task connection unavailable' });
    return;
  }
  const operation = String(req.params.operation);
  if (!['list-tools', 'call-tool'].includes(operation)) {
    res.status(404).end();
    return;
  }
  const abort = new AbortController();
  entry.controllers.add(abort);
  const timeout = setTimeout(() => abort.abort(), Math.min(150000, entry.expiresAt - Date.now()));
  const disconnect = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on('close', disconnect);
  res.setHeader('Cache-Control', 'no-store');
  try {
    const definition = await getServerDao().findById(entry.server);
    const target = definition?.targets?.find(
      (value) => value.path === entry.target && value.kind === 'task',
    );
    const key = entry.keyId ? await getBearerKeyDao().findById(entry.keyId) : undefined;
    if (
      !definition ||
      definition.enabled === false ||
      !target ||
      !(await authorizeTargetForCaller(
        entry.server,
        target,
        { username: entry.username, isAdmin: true },
        entry.keyId,
      )) ||
      (entry.keyId &&
        (!key?.enabled || (key.kind ?? 'system') !== 'system' || key.accessType !== 'all'))
    )
      throw new Error('Task target unavailable');
    if (
      operation === 'call-tool' &&
      (typeof req.body?.tool_name !== 'string' ||
        !req.body.tool_name.startsWith(`${entry.server}_`) ||
        !req.body.tool_args ||
        typeof req.body.tool_args !== 'object' ||
        Array.isArray(req.body.tool_args))
    ) {
      res.status(400).json({ message: 'Invalid tool call' });
      return;
    }
    const headers = {
      ...req.headers,
      'x-mcphub-target': entry.target,
      'x-mcphub-task-id': entry.taskId,
    };
    const call = async () => {
      const response = await fetch(`${entry.url}/${operation}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${entry.upstreamToken}`,
        },
        body: JSON.stringify(
          operation === 'list-tools'
            ? {}
            : { tool_name: req.body.tool_name, tool_args: req.body.tool_args, use_cache: false },
        ),
        signal: abort.signal,
        redirect: 'error',
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('Task response too large');
          }
          chunks.push(chunk.value);
        }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!response.ok) {
        const error = new Error(`Task upstream HTTP ${response.status}`) as Error & {
          status: number;
        };
        error.status = response.status;
        throw error;
      }
      const result: unknown = JSON.parse(raw);
      if (operation === 'list-tools') {
        const tools = Array.isArray(result) ? result : (result as { tools?: unknown[] })?.tools;
        if (!Array.isArray(tools)) throw new Error('Invalid task inventory');
        return tools.filter(
          (tool) =>
            tool &&
            typeof (tool as { name?: unknown }).name === 'string' &&
            (tool as { name: string }).name.startsWith(`${entry.server}_`),
        );
      }
      if (Array.isArray(result)) return { content: result, isError: false };
      if (
        !result ||
        typeof result !== 'object' ||
        !Array.isArray((result as { content?: unknown }).content)
      )
        throw new Error('Invalid task result');
      return result as { content: unknown[]; isError?: boolean };
    };
    const result = await RequestContextService.getInstance().runWithCustomRequestContext(
      { headers },
      async () =>
        operation === 'list-tools'
          ? call()
          : withToolAudit(
              {
                server: entry.server,
                tool: req.body.tool_name,
                target: entry.target,
                taskId: entry.taskId,
              },
              () =>
                toolCallScheduler.run(
                  entry.server,
                  call as () => Promise<{ content: unknown[]; isError?: boolean }>,
                  entry.owner,
                  abort.signal,
                ),
            ),
    );
    res.json(result);
  } catch {
    if (!res.headersSent && !res.destroyed)
      res.status(abort.signal.aborted ? 504 : 502).json({
        content: [
          {
            type: 'text',
            text: abort.signal.aborted
              ? 'Error: Task request timed out or cancelled'
              : 'Error: Task request failed',
          },
        ],
        isError: true,
      });
  } finally {
    clearTimeout(timeout);
    res.off('close', disconnect);
    entry.controllers.delete(abort);
  }
}
