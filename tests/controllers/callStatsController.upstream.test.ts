import express from 'express';
import request from 'supertest';
const mockTool = jest.fn(async () => ({ total: 1 }));
const mockYibu = jest.fn(async () => ({ total: 3, keyRows: [] }));
jest.mock('../../src/services/yibuStatsService.js', () => ({
  getYibuStats: (...args: unknown[]) => mockYibu(...(args as [])),
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({ findAll: async () => [] }),
}));
const mockUpstream = jest.fn(async () => ({ total: 2, keyRows: [] }));
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

it('supports persistent Yibu key statistics for whole UTC days with the same admin and fingerprint boundary', async () => {
  await request(app).get('/stats?metric=yibu&credentialId=0123456789abcdef').expect(200);
  expect(mockYibu).toHaveBeenCalledWith(
    expect.objectContaining({ metric: 'yibu', credentialId: '0123456789abcdef' }),
    expect.any(Map),
  );
  await request(app).get('/stats?metric=yibu&credentialId=raw-key').expect(400);
  await request(app).get('/stats?metric=yibu&start=2026-11-01T12:00:00Z').expect(400);
  admin = false;
  await request(app).get('/stats?metric=yibu').expect(403);
  expect(mockYibu).toHaveBeenCalledTimes(1);
});

it('accepts local calendar boundaries and rejects invalid zones or partial days', async () => {
  await request(app)
    .get('/stats')
    .query({
      metric: 'yibu',
      timeZone: 'Asia/Shanghai',
      start: '2026-11-21T16:00:00.000Z',
      end: '2026-11-22T15:59:59.999Z',
    })
    .expect(200);
  expect(mockYibu).toHaveBeenCalledWith(
    expect.objectContaining({ timeZone: 'Asia/Shanghai', start: '2026-11-21T16:00:00.000Z' }),
    expect.any(Map),
  );
  await request(app).get('/stats').query({ metric: 'yibu', timeZone: '../../invalid' }).expect(400);
  await request(app)
    .get('/stats')
    .query({ metric: 'yibu', timeZone: 'Asia/Shanghai', start: '2026-11-22T01:00:00Z' })
    .expect(400);
});
