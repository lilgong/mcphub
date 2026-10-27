import type { Request, Response } from 'express';
import { runtimeWorkers } from '../services/runtimeWorkerService.js';
import { requireAdmin } from '../utils/requireAdmin.js';

export async function getRuntimeWorkers(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  try {
    const data = await Promise.all(
      runtimeWorkers().map(async ({ id, catalog, url, token, servers, targets }) => {
        try {
          const health = new URL(url);
          health.protocol = health.protocol === 'wss:' ? 'https:' : 'http:';
          health.pathname = '/health';
          const response = await fetch(health, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(3000),
            redirect: 'error',
          });
          if (!response.ok) throw new Error('Worker unavailable');
          const result = (await response.json()) as { catalog?: string; processes?: unknown[] };
          if (result.catalog !== catalog || !Array.isArray(result.processes))
            throw new Error('Worker identity mismatch');
          return {
            id,
            catalog,
            servers,
            targets,
            status: 'connected',
            processes: result.processes,
          };
        } catch {
          return { id, catalog, servers, targets, status: 'disconnected' };
        }
      }),
    );
    res.json({ success: true, data });
  } catch {
    res.status(500).json({ success: false, message: 'Invalid runtime worker configuration' });
  }
}
