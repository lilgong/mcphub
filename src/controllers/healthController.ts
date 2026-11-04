import { Request, Response } from 'express';
import { getDatabaseHealth } from '../db/connection.js';
import { getServerConnectionStats } from '../services/mcpService.js';
import { logger } from '../utils/logger.js';
import { relayRuntimeService } from '../services/relayRuntimeService.js';

const isDatabaseModeEnabled = (): boolean => {
  return process.env.USE_DB !== undefined ? process.env.USE_DB === 'true' : !!process.env.DB_URL;
};

/**
 * Health check endpoint
 * Returns 200 OK when MCPHub core is healthy.
 * Returns 503 Service Unavailable when MCPHub core is unhealthy.
 */
export const healthCheck = async (_req: Request, res: Response): Promise<void> => {
  try {
    const serverStats = getServerConnectionStats();

    if (isDatabaseModeEnabled()) {
      const databaseHealth = getDatabaseHealth();
      if (!databaseHealth.healthy) {
        res.status(503).json({
          status: 'unhealthy',
          message: databaseHealth.lastError || 'Database health check failed',
          servers: serverStats,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    const relay = await relayRuntimeService.readiness();
    if (relay && !relay.healthy) {
      res.status(503).json({
        status: 'unhealthy',
        message: 'Configured Relay is unavailable',
        servers: serverStats,
        relay,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (serverStats.disconnected === 0) {
      res.status(200).json({
        status: 'healthy',
        message: 'All enabled MCP servers are ready',
        servers: serverStats,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(200).json({
        status: 'degraded',
        message: 'Some enabled MCP servers are not ready',
        servers: serverStats,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      message: 'Internal server error during health check',
      timestamp: new Date().toISOString(),
    });
  }
};
