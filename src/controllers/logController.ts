// filepath: /Users/sunmeng/code/github/mcphub/src/controllers/logController.ts
import { Request, Response } from 'express';
import logService from '../services/logService.js';
import { logger } from '../utils/logger.js';
import { requireAdmin } from '../utils/requireAdmin.js';

// Get all logs
export const getAllLogs = async (req: Request, res: Response): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;

  try {
    const logs = logService.getLogs();
    res.json({ success: true, data: logs });
  } catch (error) {
    logger.error('Error getting logs:', error);
    res.status(500).json({ success: false, error: 'Error getting logs' });
  }
};

// Clear all logs
export const clearLogs = async (req: Request, res: Response): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;

  try {
    logService.clearLogs();
    res.json({ success: true, message: 'Logs cleared successfully' });
  } catch (error) {
    logger.error('Error clearing logs:', error);
    res.status(500).json({ success: false, error: 'Error clearing logs' });
  }
};

// Stream logs via SSE
export const streamLogs = async (req: Request, res: Response): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;

  try {
    // Set headers for SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send initial data
    const logs = logService.getLogs();
    res.write(`data: ${JSON.stringify({ type: 'initial', logs })}\n\n`);

    // Subscribe to log and auxiliary stream events
    const unsubscribe = logService.subscribeToStream((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Handle client disconnect
    req.on('close', () => {
      unsubscribe();
      logger.log('Client disconnected from log stream');
    });
  } catch (error) {
    logger.error('Error streaming logs:', error);
    res.status(500).json({ success: false, error: 'Error streaming logs' });
  }
};

export const getCallLogs = async (req: Request, res: Response): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  const date =
    typeof req.query.date === 'string' ? req.query.date : new Date().toISOString().slice(0, 10);
  const status = typeof req.query.status === 'string' ? req.query.status : 'all';
  const source = typeof req.query.source === 'string' ? req.query.source : 'all';
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 50);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date ||
    (!['all', 'none', '4xx', '5xx'].includes(status) && !/^[1-5]\d{2}$/.test(status)) ||
    !['all', 'tool', 'yibu', 'relay'].includes(source) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  ) {
    res.status(400).json({ success: false, message: 'Invalid call log filter' });
    return;
  }
  try {
    const service = await import('../services/callLogService.js');
    res.json({
      success: true,
      data: await service.getCallLogs({
        date,
        status,
        source,
        page,
        limit,
        errorsOnly: req.query.errorsOnly !== 'false',
        server: typeof req.query.server === 'string' ? req.query.server.slice(0, 128) : '',
      }),
    });
  } catch {
    res.status(500).json({ success: false, message: 'Call logs unavailable' });
  }
};
