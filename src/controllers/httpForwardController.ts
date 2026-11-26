import type { Request, Response } from 'express';
import { getServerDao, getUserDao, getBearerKeyDao, getGroupDao } from '../dao/index.js';
import { validateBearerAuth } from '../services/sseService.js';
import { authorizationService } from '../services/authorizationService.js';
import { getUserGroupPolicy, userGroupAllows } from '../services/userGroupService.js';
import { expandServerConfig } from '../services/serverConfigEnvironment.js';
import { forwardingRequestHeaders, forwardingLocation } from '../utils/httpForwardHeaders.js';
import { upstreamCredential } from '../utils/upstreamCredential.js';
import { streamWorkspaceHttp } from '../services/workspaceHttpStreamService.js';
import { forwardingUrl } from '../services/httpForwardService.js';
import { withToolAudit, captureToolDiagnostic } from '../services/toolAuditService.js';
import { toolCallScheduler } from '../services/toolCallSchedulerService.js';
import { RequestContextService } from '../services/requestContextService.js';

/** Fixed-resource HTTP endpoint. A Hub key is consumed here, never sent upstream. */
export async function forwardHttp(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const name = String(req.params[0] ?? req.params.group);
  req.params.group = name;
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) {
    res.status(405).json({ error: 'Method not supported' });
    return;
  }
  const abort = new AbortController();
  const close = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on('close', close);
  try {
    const auth = await validateBearerAuth(req);
    // Credential-bearing HTTP resources never allow anonymous fallback.
    if (!auth.valid || (!auth.keyId && !auth.user)) {
      res
        .status(!auth.valid && auth.reason === 'forbidden' ? 403 : 401)
        .json({ error: 'Hub authentication required' });
      return;
    }
    const principal = auth.user ?? { username: 'system', isAdmin: true };
    const loadAuthorized = async () => {
      const currentAuth = await validateBearerAuth(req);
      if (
        !currentAuth.valid ||
        currentAuth.keyId !== auth.keyId ||
        currentAuth.user?.username !== auth.user?.username
      )
        throw Object.assign(new Error('Permission revoked'), { status: 403 });
      const resource = await getServerDao().findById(name);
      if (!resource || resource.type !== 'http-proxy' || resource.enabled === false)
        throw Object.assign(new Error('HTTP resource unavailable'), { status: 404 });
      const key = auth.keyId ? await getBearerKeyDao().findById(auth.keyId) : null;
      if (key && key.kind !== 'user' && key.accessType !== 'all') {
        let allowed =
          (key.accessType === 'servers' || key.accessType === 'custom') &&
          key.allowedServers?.includes(name);
        if (!allowed && (key.accessType === 'groups' || key.accessType === 'custom')) {
          for (const reference of key.allowedGroups ?? []) {
            const group =
              (await getGroupDao().findByName(reference)) ??
              (await getGroupDao().findById(reference));
            if (
              group?.servers.some(
                (entry) => (typeof entry === 'string' ? entry : entry.name) === name,
              )
            )
              allowed = true;
          }
        }
        if (!allowed) throw Object.assign(new Error('Resource scope denied'), { status: 403 });
      }
      const policy = await getUserGroupPolicy(principal, auth.keyId);
      if (
        !userGroupAllows(policy, name) ||
        !authorizationService.can('server.invoke', resource, principal)
      )
        throw Object.assign(new Error('Resource access denied'), { status: 403 });
      return resource;
    };
    const resource = await loadAuthorized();
    const raw = req.originalUrl.split('?')[0];
    const match = raw.match(/\/http\/[^/]+(\/.*)?$/);
    const path = match?.[1] ?? '';
    const clientPrefix = raw.slice(0, raw.length - (match?.[1]?.length ?? 0));
    const query = req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : '';
    // Validate before queuing, without exposing the operator URL in errors.
    try {
      forwardingUrl((await expandServerConfig(resource)).url!, path, query);
    } catch {
      res.status(400).json({ error: 'Invalid forwarding path or upstream URL' });
      return;
    }
    if (!process.env.MCPHUB_AUDIT_LOG_DIR) {
      res
        .status(503)
        .json({ error: 'Configure MCPHUB_AUDIT_LOG_DIR before enabling HTTP forwarding' });
      return;
    }
    const result = await RequestContextService.getInstance().runWithCustomRequestContext(
      {
        headers: req.headers,
        keyId: auth.keyId,
        keyName: auth.keyName,
        username: principal.username,
      },
      () =>
        withToolAudit(
          {
            server: name,
            tool: `HTTP ${req.method}`,
            username: principal.username,
            keyId: auth.keyId,
            keyName: auth.keyName,
            sourceIp: req.ip,
          },
          () =>
            toolCallScheduler.run(
              name,
              async () => {
                const current = await loadAuthorized();
                const config = await expandServerConfig(current);
                const owner = config.owner ? await getUserDao().findByUsername(config.owner) : null;
                const url = forwardingUrl(config.url!, path, query);
                const log = captureToolDiagnostic(name);
                try {
                  const headers = forwardingRequestHeaders(req.headers, config.headers);
                  const credentials = Object.entries(config.headers ?? {})
                    .filter(
                      ([name, value]) => value && /authorization|key|token|secret/i.test(name),
                    )
                    .map(([name, value]) => upstreamCredential(value, name.toLowerCase()));
                  const response = await streamWorkspaceHttp(
                    req,
                    res,
                    url,
                    headers,
                    abort.signal,
                    credentials,
                    undefined,
                    {
                      allowInternal: owner?.isAdmin === true,
                      timeout: config.options?.timeout ?? 60000,
                      mapLocation: (location) =>
                        forwardingLocation(location, url, config.url!, clientPrefix),
                    },
                  );
                  log('completed', { http_status: response.status });
                  return response;
                } catch (error) {
                  if (res.headersSent) throw error;
                  const status =
                    abort.signal.aborted || (error as { code?: string }).code === 'ECONNABORTED'
                      ? 504
                      : 502;
                  log('completed', {
                    http_status: status,
                    category: status === 504 ? 'timeout' : 'network_error',
                  });
                  return {
                    isError: true,
                    status,
                    body: Buffer.from(
                      JSON.stringify({
                        error:
                          status === 504 ? 'Upstream request timed out' : 'Upstream request failed',
                      }),
                    ),
                    headers: { 'content-type': 'application/json' },
                  };
                }
              },
              principal.username,
              abort.signal,
            ),
          true,
        ),
    );
    if (!res.destroyed) {
      if ('streamed' in result && result.streamed) {
        res.end();
        return;
      }
      for (const [header, value] of Object.entries(result.headers)) res.setHeader(header, value);
      res.status(result.status).send(result.body);
    }
  } catch (error) {
    if (res.headersSent && !res.destroyed) res.destroy(new Error('HTTP upstream stream failed'));
    const status = (error as { status?: number }).status;
    if (!res.headersSent && !res.destroyed)
      res
        .status(
          status === 403 || status === 404
            ? status
            : /queue/i.test(String((error as Error).message))
              ? 429
              : 503,
        )
        .json({
          error:
            status === 403
              ? 'Resource access denied'
              : status === 404
                ? 'HTTP resource unavailable'
                : 'HTTP forwarding failed',
        });
  } finally {
    res.off('close', close);
  }
}
