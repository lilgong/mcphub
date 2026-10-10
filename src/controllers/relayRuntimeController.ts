import type { Request, Response } from 'express';
import { requireAdmin } from '../utils/requireAdmin.js';
import { relayRuntimeService, RelayRuntimeError } from '../services/relayRuntimeService.js';
import { reconnectRelayServers } from './atlasController.js';

async function handle(req: Request, res: Response, action: () => Promise<unknown>): Promise<void> {
  if (!(await requireAdmin(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json({ success: true, data: await action() });
  } catch (error) {
    res.status(error instanceof RelayRuntimeError ? error.status : 500).json({
      success: false,
      message: error instanceof RelayRuntimeError ? error.message : 'Relay operation failed',
    });
  }
}

export async function relayRuntime(req: Request, res: Response): Promise<void> {
  await handle(req, res, () => relayRuntimeService.status());
}
export async function startRelay(req: Request, res: Response): Promise<void> {
  await handle(req, res, async () => ({
    runtime: await relayRuntimeService.start(),
    reconnectFailed: await reconnectRelayServers(),
  }));
}
export async function stopRelay(req: Request, res: Response): Promise<void> {
  await handle(req, res, () => relayRuntimeService.stop());
}
export async function resetRelayToken(req: Request, res: Response): Promise<void> {
  await handle(req, res, async () => ({
    token: await relayRuntimeService.resetToken(),
    reconnectFailed: await reconnectRelayServers(),
  }));
}
