import type { Request, Response } from 'express';
import axios from 'axios';
import { connect } from 'node:http2';
import { requestHttpUpstream } from '../../src/services/httpForwardService.js';
import { streamWorkspaceHttp } from '../../src/services/workspaceHttpStreamService.js';
import { requestGrpcUpstream } from '../../src/services/grpcForwardService.js';

const mockAdmission = jest.fn();
jest.mock('../../src/services/toolAuditService.js', () => ({
  captureToolDiagnostic: () => mockAdmission,
}));
jest.mock('../../src/utils/ssrf.js', () => ({
  assertSafeUrl: async () => undefined,
  ssrfConnectionOptions: () => ({}),
  createSafeLookup: jest.fn(),
}));
jest.mock('node:http2', () => ({ connect: jest.fn() }));

beforeEach(() => mockAdmission.mockReset().mockRejectedValue(new Error('audit unavailable')));
afterEach(() => jest.restoreAllMocks());

test.each(['http', 'stream', 'grpc'])(
  '%s does not dispatch credentials after asynchronous audit rejection',
  async (kind) => {
    const send = jest.spyOn(axios, 'request');
    const signal = new AbortController().signal;
    const url = 'https://provider.example/request';
    const promise =
      kind === 'http'
        ? requestHttpUpstream(
            { headers: { authorization: 'Bearer secret' } },
            url,
            'POST',
            Buffer.from('{}'),
            {},
            signal,
            false,
          )
        : kind === 'stream'
          ? streamWorkspaceHttp(
              { method: 'POST' } as Request,
              {} as Response,
              url,
              { authorization: 'Bearer secret' },
              signal,
              [],
            )
          : requestGrpcUpstream(
              url,
              Buffer.from('{}'),
              { authorization: 'Bearer secret' },
              signal,
              [],
            );
    await expect(promise).rejects.toThrow('audit unavailable');
    expect(send).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(mockAdmission).toHaveBeenCalledWith('upstream_started', expect.any(Object));
  },
);
