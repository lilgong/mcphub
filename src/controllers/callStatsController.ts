import { wholeCalendarDays } from '../utils/calendarTime.js';
import { getYibuStats } from '../services/yibuStatsService.js';
import { getServerDao } from '../dao/DaoFactory.js';
import { upstreamCredentialSuffixes } from '../utils/upstreamCredentialSuffixes.js';
import { getUpstreamStats } from '../services/upstreamStatsService.js';
import type { Request, Response } from 'express';
import { requireAdmin } from '../utils/requireAdmin.js';
import { getCallStats } from '../services/callStatsService.js';
export async function callStats(req: Request, res: Response): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  const timeZone = typeof req.query.timeZone === 'string' ? req.query.timeZone : 'UTC';
  try {
    if (req.query.timeZone !== undefined && typeof req.query.timeZone !== 'string')
      throw new Error();
    new Intl.DateTimeFormat('en', { timeZone }).format();
  } catch {
    res.status(400).json({ success: false, message: 'Invalid time zone' });
    return;
  }
  const start =
    typeof req.query.start === 'string'
      ? new Date(req.query.start)
      : new Date(new Date().toISOString().slice(0, 7) + '-01T00:00:00Z');
  const end =
    typeof req.query.end === 'string'
      ? new Date(req.query.end)
      : new Date(
          req.query.metric === 'yibu'
            ? new Date().toISOString().slice(0, 10) + 'T23:59:59.999Z'
            : Date.now(),
        );
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
    !['tool', 'upstream', 'yibu'].includes(metric) ||
    (req.query.credentialId !== undefined &&
      (typeof req.query.credentialId !== 'string' ||
        !/^[a-f0-9]{16}$/.test(req.query.credentialId))) ||
    (credentialId && metric === 'tool')
  ) {
    res
      .status(400)
      .json({ success: false, message: 'Invalid statistics metric or credential fingerprint' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    const query = {
      start: start.toISOString(),
      end: end.toISOString(),
      server: read('server'),
      catalog: read('catalog'),
      credentialId,
      metric,
      ...(req.query.timeZone !== undefined ? { timeZone } : {}),
    };
    if (metric === 'yibu' && !wholeCalendarDays(start, end, timeZone)) {
      res
        .status(400)
        .json({
          success: false,
          message: 'Yibu usage requires whole days in the selected time zone',
        });
      return;
    }
    if (metric !== 'tool') {
      let suffixes = new Map<string, string>();
      try {
        suffixes = upstreamCredentialSuffixes(await getServerDao().findAll());
      } catch {
        // A configuration outage must not hide otherwise readable usage history.
      }
      const data =
        metric === 'yibu' ? await getYibuStats(query, suffixes) : await getUpstreamStats(query);
      for (const row of data.keyRows) row.credentialSuffix ||= suffixes.get(row.credentialId);
      res.json({ success: true, data });
    } else {
      res.json({ success: true, data: await getCallStats(query) });
    }
  } catch {
    res.status(500).json({ success: false, message: 'Statistics unavailable' });
  }
}
