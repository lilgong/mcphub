import { Request, Response } from 'express';

const mockGetLogs = jest.fn();
const mockClearLogs = jest.fn();
const mockSubscribeToStream = jest.fn();

jest.mock('../../src/services/logService.js', () => ({
  default: {
    getLogs: mockGetLogs,
    clearLogs: mockClearLogs,
    subscribeToStream: mockSubscribeToStream,
  },
}));

import {
  clearLogs,
  getAllLogs,
  streamLogs,
  getCallLogs,
  getLogCatalogs,
} from '../../src/controllers/logController.js';

const makeRes = () =>
  ({
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    writeHead: jest.fn(),
    write: jest.fn(),
  }) as unknown as Response;

const makeReq = () =>
  ({
    user: { username: 'alice', isAdmin: false },
    on: jest.fn(),
  }) as unknown as Request;

describe('logController authorization', () => {
  it('rejects non-admin access to log read, clear, and stream endpoints', async () => {
    const handlers = [getAllLogs, clearLogs, streamLogs, getCallLogs, getLogCatalogs];

    for (const handler of handlers) {
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: 'Admin privileges required',
      });
    }

    expect(mockGetLogs).not.toHaveBeenCalled();
    expect(mockClearLogs).not.toHaveBeenCalled();
    expect(mockSubscribeToStream).not.toHaveBeenCalled();
  });
});

describe('call log filter validation', () => {
  it.each([
    { date: '../secrets' },
    { date: '2026-02-30' },
    { status: 'secret' },
    { source: 'unknown' },
    { page: '0' },
    { limit: '10000' },
  ])('rejects invalid filters %j', async (query) => {
    const res = makeRes();
    await getCallLogs({ user: { isAdmin: true }, query } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
