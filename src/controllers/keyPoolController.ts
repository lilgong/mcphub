import type { Request, Response } from 'express';
import { authenticateKeyPool, keyPoolService } from '../services/keyPoolService.js';
/** Internal child-MCP requests use a per-server, process-local capability. */
export async function forwardKeyPool(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const server = String(req.params.name);
  const token = req.get('authorization')?.replace(/^Bearer /, '') || '';
  if (!authenticateKeyPool(server, token)) {
    res.status(403).json({ message: 'Key pool capability required' });
    return;
  }
  if (typeof req.body?.url !== 'string' || req.body.url.length > 16384) {
    res.status(400).json({ message: 'Invalid key pool request' });
    return;
  }
  const abort = new AbortController();
  const close = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.on('close', close);
  const timeout = setTimeout(() => abort.abort(), 55000);
  try {
    const result = await keyPoolService.request(server, req.body.url, abort.signal);
    res.json(result);
  } catch {
    res
      .status(abort.signal.aborted ? 504 : 502)
      .json({
        message: abort.signal.aborted
          ? 'Key pool request timed out or cancelled'
          : 'Key pool request failed',
      });
  } finally {
    clearTimeout(timeout);
    res.off('close', close);
  }
}
