import { ipPoolConnectionOptions, type HttpEgress } from './ipPoolTransportService.js';
import type { Request, Response } from 'express';
import axios from 'axios';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { assertSafeUrl, ssrfConnectionOptions } from '../utils/ssrf.js';
import { captureToolDiagnostic } from './toolAuditService.js';
import type { ForwardResponse } from './httpForwardService.js';
import type { upstreamCredential } from '../utils/upstreamCredential.js';
import type { WorkspaceHttpBinding } from '../types/workspace.js';
import { decodedHttpPreview } from '../utils/httpResponseBody.js';
import { forwardingResponseHeaders } from '../utils/httpForwardHeaders.js';
import { workspaceHttpResult } from '../utils/workspaceHttp.js';

/** Forward opaque HTTP bytes with backpressure and no fixed payload size cap. */
export async function streamWorkspaceHttp(
  req: Request,
  res: Response,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  credentials: ReturnType<typeof upstreamCredential>[],
  responseError?: WorkspaceHttpBinding['responseError'],
  options: {
    allowInternal?: boolean;
    egress?: HttpEgress;
    timeout?: number;
    mapLocation?: (location: string) => string;
  } = {},
): Promise<ForwardResponse> {
  await assertSafeUrl(url, { allowInternal: options.allowInternal === true });
  const log = captureToolDiagnostic('');
  const metadata = {
    ...(options.egress ? { egress_backend: 'ipwo' } : {}),
    upstream_request_id: randomUUID(),
    http_method: req.method,
    upstream_host: new URL(url).hostname,
    upstream_path: new URL(url).pathname.slice(0, 1000),
    upstream_credentials: JSON.stringify(credentials),
    credential_suffix: credentials.map((value) => `${value.role}: …${value.suffix}`).join(', '),
  };
  await log('upstream_started', metadata);
  const started = Date.now();
  const idle = new AbortController();
  signal = AbortSignal.any([signal, idle.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    clearTimeout(timer);
    if (options.timeout && options.timeout > 0)
      timer = setTimeout(() => idle.abort(), options.timeout);
  };
  resetIdle();
  try {
    const response = await axios.request<Readable>({
      url,
      method: req.method,
      headers,
      data: ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : Buffer.isBuffer(req.body)
          ? Readable.from(req.body)
          : req,
      signal,
      timeout: options.timeout ?? 0,
      onUploadProgress: resetIdle,
      maxRedirects: 0,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      responseType: 'stream',
      decompress: false,
      validateStatus: () => true,
      transformRequest: [(value) => value],
      ...ssrfConnectionOptions(options.allowInternal === true),
      ...ipPoolConnectionOptions(url, options.egress),
      proxy: false,
    });
    resetIdle();
    res.status(response.status);
    for (const [name, value] of Object.entries(forwardingResponseHeaders(response.headers))) {
      res.setHeader(
        name,
        name === 'location' && options.mapLocation && typeof value === 'string'
          ? options.mapLocation(value)
          : value,
      );
    }
    const preview: Buffer[] = [];
    let previewSize = 0;
    for await (const chunk of response.data) {
      resetIdle();
      if ((response.status === 403 || responseError) && previewSize < 1024 * 1024) {
        preview.push(Buffer.from(chunk).subarray(0, 1024 * 1024 - previewSize));
        previewSize += chunk.length;
      }
      if (!res.write(chunk)) {
        // Downstream backpressure is not upstream read inactivity.
        clearTimeout(timer);
        await once(res, 'drain', { signal });
        resetIdle();
      }
    }
    clearTimeout(timer);
    let rateLimited = response.status === 429;
    try {
      rateLimited ||= /secondary rate limit|API rate limit exceeded/i.test(
        JSON.parse(
          decodedHttpPreview(
            Buffer.concat(preview),
            String(response.headers['content-encoding'] || ''),
          ).toString(),
        ).message || '',
      );
    } catch {
      /* Metadata only. */
    }
    const classification = workspaceHttpResult(responseError, {
      status: response.status,
      isError: response.status >= 400,
      body: Buffer.concat(preview),
      headers: { 'content-encoding': String(response.headers['content-encoding'] || '') },
    });
    await log('upstream_finished', {
      ...metadata,
      http_status: response.status,
      status: classification.isError ? 'error' : 'success',
      duration_ms: Date.now() - started,
    });
    // The caller ends the response after the mandatory final audit record is written.
    return {
      streamed: true,
      status: response.status,
      isError: classification.isError,
      ...(rateLimited ? { rateLimited: true } : {}),
      body: Buffer.alloc(0),
      headers: Object.fromEntries(
        [
          'retry-after',
          'x-ratelimit-limit',
          'x-ratelimit-remaining',
          'x-ratelimit-reset',
          'x-ratelimit-resource',
        ]
          .filter((name) => response.headers[name] !== undefined)
          .map((name) => [name, String(response.headers[name])]),
      ),
    };
  } catch (error) {
    const failure = idle.signal.aborted
      ? Object.assign(new Error('Workspace upstream response read timed out'), {
          code: 'UPSTREAM_TIMEOUT',
        })
      : error;
    await log('upstream_finished', {
      ...metadata,
      http_status:
        signal.aborted || (error as { code?: string }).code === 'ECONNABORTED' ? 504 : 502,
      timeout_phase: idle.signal.aborted ? 'response_read' : undefined,
      status: 'error',
      duration_ms: Date.now() - started,
    });
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}
