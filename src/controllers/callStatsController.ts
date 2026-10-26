import { getUpstreamStats } from '../services/upstreamStatsService.js';
import type { Request, Response } from 'express';
import { requireAdmin } from '../utils/requireAdmin.js';
import { getCallStats } from '../services/callStatsService.js';
export async function callStats(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  const start =
    typeof req.query.start === 'string'
      ? new Date(req.query.start)
      : new Date(new Date().toISOString().slice(0, 7) + '-01T00:00:00Z');
  const end = typeof req.query.end === 'string' ? new Date(req.query.end) : new Date();
  if (
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    end < start ||
    +end - +start > 366 * 86400000
  ) {
    res
      .status(400)
      .json({ success: false, message: 'Invalid statistics range (maximum 366 days)' });
    return;
  }
  if (req.query.groupBy !== undefined && req.query.groupBy !== 'server') {
    res.status(400).json({ success: false, message: 'Statistics are grouped by MCP server' });
    return;
  }
  const read = (key: string) =>
    typeof req.query[key] === 'string' ? (req.query[key] as string).slice(0, 160) : undefined;
  const metric = read('metric') || 'tool';
  const credentialId = read('credentialId');
  if (
    !['tool', 'upstream'].includes(metric) ||
    (req.query.credentialId !== undefined &&
      (typeof req.query.credentialId !== 'string' ||
        !/^[a-f0-9]{16}$/.test(req.query.credentialId))) ||
    (credentialId && metric !== 'upstream')
  ) {
    res
      .status(400)
      .json({ success: false, message: 'Invalid statistics metric or credential fingerprint' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json({
      success: true,
      data: await (metric === 'upstream' ? getUpstreamStats : getCallStats)({
        start: start.toISOString(),
        end: end.toISOString(),
        server: read('server'),
        catalog: read('catalog'),
        credentialId,
        metric,
      }),
    });
  } catch {
    res.status(500).json({ success: false, message: 'Statistics unavailable' });
  }
}
