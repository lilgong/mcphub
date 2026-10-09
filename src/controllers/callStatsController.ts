import type { Request, Response } from 'express';
import { requireAdmin } from '../utils/requireAdmin.js';
import { getCallStats, type StatsGrouping } from '../services/callStatsService.js';
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
  const groupBy = req.query.groupBy ?? 'server';
  if (
    typeof groupBy !== 'string' ||
    !['server', 'target', 'model', 'benchmark', 'all'].includes(groupBy)
  ) {
    res.status(400).json({ success: false, message: 'Invalid statistics grouping' });
    return;
  }
  const read = (key: string) =>
    typeof req.query[key] === 'string' ? (req.query[key] as string).slice(0, 160) : undefined;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json({
      success: true,
      data: await getCallStats({
        groupBy: groupBy as StatsGrouping,
        start: start.toISOString(),
        end: end.toISOString(),
        server: read('server'),
        target: read('target'),
        model: read('model'),
        benchmark: read('benchmark'),
      }),
    });
  } catch {
    res.status(500).json({ success: false, message: 'Statistics unavailable' });
  }
}
