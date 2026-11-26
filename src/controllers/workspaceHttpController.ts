import { workspaceUpstreamTimeout } from '../utils/workspaceTimeout.js';
import { followGithubRestRedirects } from '../services/githubRedirectService.js';
import { GITHUB_HOSTS, githubRequestScheduler } from '../services/githubRequestSchedulerService.js';
import type { Request, Response } from 'express';
import { getServerDao } from '../dao/DaoFactory.js';
import { accessWorkspaceRun, WorkspaceError } from '../services/workspaceService.js';
import { canUseWorkspace } from './workspaceController.js';
import { getUserGroupPolicy, userGroupAllows } from '../services/userGroupService.js';
import { forwardingRequestHeaders } from '../utils/httpForwardHeaders.js';
import { forwardingUrl, requestHttpUpstream } from '../services/httpForwardService.js';
import { withToolAudit } from '../services/toolAuditService.js';
import { toolCallScheduler } from '../services/toolCallSchedulerService.js';
import { RequestContextService } from '../services/requestContextService.js';
import type { ServerConfig } from '../types/index.js';
import { upstreamCredential } from '../utils/upstreamCredential.js';
import {
  workspaceHttpSecret,
  workspaceHttpUrl,
  workspaceHttpResult,
  workspaceAssetHost,
  headerContainsCredential,
} from '../utils/workspaceHttp.js';
import { requestGrpcUpstream } from '../services/grpcForwardService.js';
import { streamWorkspaceHttp } from '../services/workspaceHttpStreamService.js';

type Caller = Request & {
  user?: { username: string; isAdmin: boolean; credentialEligible?: boolean };
  bearerKey?: { id: string; userGroupId?: string };
};

async function opaqueBody(req: Request): Promise<Buffer> {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** Raw HTTP, including Git smart HTTP, bound to a live run and an operator-declared origin. */
export async function workspaceHttp(req: Caller, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const abort = new AbortController();
  const disconnect = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on('close', disconnect);
  try {
    if (
      !req.user ||
      !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)
    )
      throw new WorkspaceError('Request not permitted', 403);
    const timeoutHeader = req.get('X-MCPHub-Upstream-Timeout-Ms');
    try {
      workspaceUpstreamTimeout(timeoutHeader);
    } catch {
      throw new WorkspaceError('Invalid upstream timeout budget');
    }
    if (!process.env.MCPHUB_AUDIT_LOG_DIR)
      throw new WorkspaceError('HTTP audit is unavailable', 503);
    const [id, name, bindingId] = [0, 1, 2].map((key) => String(req.params[key] ?? ''));
    const rawPath = req.originalUrl.split('?')[0].match(/\/http\/[^/]+\/[^/]+(\/.*)?$/)?.[1];
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new WorkspaceError('Invalid MCP name');
    const owner = req.bearerKey?.id || `user:${req.user.username}`;
    const load = async () => {
      const { run, workspace } = await accessWorkspaceRun(
        id,
        req.get('X-MCPHub-Run-Token') || '',
        owner,
        (account) => canUseWorkspace(req, account),
      );
      const server = `${run.catalog}::${name}`;
      const definition = await getServerDao().findById(server);
      const policy = await getUserGroupPolicy(req.user!, req.bearerKey?.id);
      const allowed = definition?.targets?.length
        ? definition.targets.some(
            (target) =>
              target.kind === 'task' &&
              target.enabled !== false &&
              userGroupAllows(policy, server, target.path),
          )
        : userGroupAllows(policy, server);
      if (
        !allowed ||
        !definition ||
        definition.enabled === false ||
        definition.workspaceSchema?.enabled !== true
      )
        throw new WorkspaceError('MCP account access denied', 403);
      const binding = definition.workspaceSchema.http?.find((entry) => entry.id === bindingId);
      if (!binding) throw new WorkspaceError('HTTP binding unavailable', 404);
      const secret = workspaceHttpSecret(binding, workspace);
      if (!secret || (!binding.credential.forward && /[\r\n]/.test(secret)))
        throw new WorkspaceError('Required upstream credential unavailable', 409);
      const auth = binding.credential;
      let value =
        auth.forward || binding.assetHosts
          ? req.get('X-MCPHub-Forward-Authorization') || ''
          : auth.username === undefined
            ? (auth.prefix ?? '') + secret
            : 'Basic ' + Buffer.from(`${auth.username}:${secret}`).toString('base64');
      if (/[\r\n]/.test(value)) throw new WorkspaceError('Invalid upstream authorization');
      const hubKey = req.get('Authorization')?.replace(/^Bearer\s+/i, '') || '';
      if (
        headerContainsCredential(value, hubKey) ||
        headerContainsCredential(value, req.get('X-MCPHub-Run-Token') || '')
      )
        throw new WorkspaceError('Hub credentials cannot be forwarded upstream');
      const query = req.originalUrl.includes('?')
        ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
        : '';
      let url: string;
      try {
        const base = workspaceHttpUrl(binding, workspace);
        if (binding.assetHosts) {
          const asset = new URL(req.get('X-MCPHub-Asset-URL') || '');
          if (
            asset.protocol !== 'https:' ||
            asset.username ||
            asset.password ||
            asset.hash ||
            (asset.port && asset.port !== '443') ||
            !workspaceAssetHost(asset.hostname, binding.assetHosts)
          )
            throw new Error('Asset origin denied');
          if (asset.href.includes(secret) || [...asset.searchParams.values()].includes(secret))
            throw new Error('Account credential in asset URL');
          if (headerContainsCredential(value, secret)) value = '';
          url = asset.href;
        } else if (rawPath === undefined) {
          const exact = new URL(base);
          exact.search = query;
          url = exact.href;
        } else url = forwardingUrl(base, rawPath, query);
      } catch {
        throw new WorkspaceError('Invalid upstream path');
      }
      const config: ServerConfig = {
        ...definition,
        // Start this finite upstream budget only after admission, not while queued.
        options: {
          ...definition.options,
          timeout: workspaceUpstreamTimeout(timeoutHeader, definition.options?.timeout),
        },
        headers: { ...binding.headers, ...(value ? { [auth.header.toLowerCase()]: value } : {}) },
      };
      return {
        server,
        config,
        url,
        secret,
        workspace: run.workspace,
        credentials: [upstreamCredential(secret, auth.value || auth.field || 'private_key')],
        protocol: binding.protocol,
        responseError: binding.responseError,
        streaming: binding.streaming,
        egress: binding.egress,
      };
    };
    const initial = await load();
    const stage = req.get('X-MCPHub-Stage');
    const headers = forwardingRequestHeaders(req.headers);
    const response = await RequestContextService.getInstance().runWithCustomRequestContext(
      { headers: req.headers, username: req.user.username, keyId: req.bearerKey?.id },
      () =>
        withToolAudit(
          {
            server: initial.server,
            tool: `HTTP ${req.method}`,
            target: initial.workspace,
            taskId: req.get('X-MCPHub-Task-Id'),
            username: req.user!.username,
            keyId: req.bearerKey?.id,
            sourceIp: req.ip,
            phase: ['prepare', 'tool', 'evaluate', 'cleanup', 'external'].includes(stage || '')
              ? stage
              : undefined,
          },
          () =>
            toolCallScheduler.run(
              initial.server,
              async () => {
                const prepared = await load();
                // REST redirects need a replayable body; Git packs retain their streaming path.
                const githubRest = new URL(prepared.url).origin === 'https://api.github.com';
                const body = prepared.streaming && !githubRest ? undefined : await opaqueBody(req);
                let upstreamUrl = prepared.url;
                const dispatch = async () => {
                  // Revalidate live authorization and resolve credentials again after admission.
                  const current = await load();
                  if (current.secret !== prepared.secret)
                    throw new WorkspaceError('Account credentials changed while queued', 409);
                  if (current.streaming && !githubRest)
                    return streamWorkspaceHttp(
                      req,
                      res,
                      current.url,
                      forwardingRequestHeaders(req.headers, current.config.headers),
                      abort.signal,
                      current.credentials,
                      current.responseError,
                      { timeout: current.config.options?.timeout, egress: current.egress },
                    );
                  if (current.protocol === 'grpc') {
                    if (req.method !== 'POST') throw new WorkspaceError('Invalid gRPC request');
                    return requestGrpcUpstream(
                      current.url,
                      body!,
                      forwardingRequestHeaders(req.headers, current.config.headers),
                      abort.signal,
                      current.credentials,
                      current.config.options?.timeout,
                    );
                  }
                  const result = await requestHttpUpstream(
                    current.config,
                    upstreamUrl,
                    req.method,
                    body,
                    headers,
                    abort.signal,
                    false,
                    Infinity,
                    current.credentials,
                    current.egress,
                  );
                  return workspaceHttpResult(current.responseError, result);
                };
                if (!GITHUB_HOSTS.has(new URL(prepared.url).hostname)) return dispatch();
                const scheduled = (url: string) => {
                  upstreamUrl = url;
                  return githubRequestScheduler.run({
                    credential: prepared.secret,
                    method: req.method,
                    url,
                    body,
                    signal: abort.signal,
                    streaming: prepared.streaming && !githubRest,
                    dispatch,
                    identify: async () => {
                      const current = await load();
                      if (current.secret !== prepared.secret)
                        throw new WorkspaceError('Account credentials changed while queued', 409);
                      return requestHttpUpstream(
                        {
                          ...current.config,
                          headers: {
                            authorization: `Bearer ${current.secret}`,
                            accept: 'application/vnd.github+json',
                            'user-agent': 'MCPHub-GitHub-identity',
                          },
                        },
                        'https://api.github.com/user',
                        'GET',
                        undefined,
                        {},
                        abort.signal,
                        false,
                        1024 * 1024,
                        current.credentials,
                      );
                    },
                  });
                };
                return githubRest
                  ? followGithubRestRedirects(prepared.url, req.method, scheduled)
                  : scheduled(prepared.url);
              },
              owner,
              abort.signal,
            ),
          true,
        ),
    );
    if (!res.destroyed) {
      if (response.streamed) {
        res.end();
        return;
      }
      for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
      res.status(response.status);
      if (req.method === 'HEAD') res.end();
      else res.send(response.body);
    }
  } catch (error) {
    if (res.headersSent && !res.destroyed)
      res.destroy(new Error('Workspace upstream stream failed'));
    if (!res.headersSent && !res.destroyed)
      res
        .status(
          error instanceof WorkspaceError
            ? error.status
            : abort.signal.aborted ||
                ['ECONNABORTED', 'ETIMEDOUT', 'UPSTREAM_TIMEOUT'].includes(
                  String((error as { code?: string })?.code),
                )
              ? 504
              : 502,
        )
        .json({
          error:
            error instanceof WorkspaceError
              ? error.message
              : ['ECONNABORTED', 'ETIMEDOUT', 'UPSTREAM_TIMEOUT'].includes(
                    String((error as { code?: string })?.code),
                  )
                ? 'Workspace upstream execution timed out'
                : 'Workspace upstream request failed',
        });
  } finally {
    res.off('close', disconnect);
  }
}
