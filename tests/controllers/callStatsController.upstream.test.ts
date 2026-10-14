import express from 'express';
import request from 'supertest';
const mockTool = jest.fn(async () => ({ total: 1 }));
const mockUpstream = jest.fn(async () => ({ total: 2 }));
let admin = true;
jest.mock('../../src/utils/requireAdmin.js', () => ({
  requireAdmin: async (_req: unknown, res: express.Response) => {
    if (!admin) res.status(403).end();
    return admin;
  },
}));
jest.mock('../../src/services/callStatsService.js', () => ({
  getCallStats: (...args: unknown[]) => mockTool(...(args as [])),
}));
jest.mock('../../src/services/upstreamStatsService.js', () => ({
  getUpstreamStats: (...args: unknown[]) => mockUpstream(...(args as [])),
}));
import { callStats } from '../../src/controllers/callStatsController';
const app = express();
app.get('/stats', callStats);
beforeEach(() => {
  admin = true;
  jest.clearAllMocks();
});
it('keeps tool statistics as default and only accepts a fingerprint for upstream statistics', async () => {
  await request(app).get('/stats').expect(200);
  expect(mockTool).toHaveBeenCalledTimes(1);
  await request(app).get('/stats?metric=upstream&credentialId=0123456789abcdef').expect(200);
  expect(mockUpstream).toHaveBeenCalledWith(
    expect.objectContaining({ credentialId: '0123456789abcdef', metric: 'upstream' }),
  );
  await request(app).get('/stats?metric=upstream&credentialId=raw-api-key').expect(400);
  await request(app).get('/stats?credentialId=0123456789abcdef').expect(400);
  expect(mockUpstream).toHaveBeenCalledTimes(1);
});
it('does not expose cross-server key statistics to non-admin users', async () => {
  admin = false;
  await request(app).get('/stats?metric=upstream').expect(403);
  expect(mockUpstream).not.toHaveBeenCalled();
});
