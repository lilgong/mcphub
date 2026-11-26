import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { requestGrpcUpstream } from '../../src/services/grpcForwardService.js';
jest.mock('node:http2', () => ({ ...jest.requireActual('node:http2'), connect: jest.fn() }));
jest.mock('../../src/utils/ssrf.js', () => ({
  assertSafeUrl: async () => undefined,
  createSafeLookup: () => undefined,
}));

test('gRPC proxy preserves unary frames and trailers over a real HTTP/2 stream', async () => {
  const server = http2.createServer();
  const received: Buffer[] = [];
  let auth = '';
  server.on('stream', (stream, headers) => {
    auth = String(headers.authorization);
    stream.on('data', (chunk: Buffer) => received.push(chunk));
    stream.on('end', () => {
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () =>
        stream.sendTrailers({ 'grpc-status': '5', 'grpc-message': 'not%20found' }),
      );
      stream.end(Buffer.from([0, 0, 0, 0, 2, 8, 1]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const actualConnect = jest.requireActual<typeof http2>('node:http2').connect;
  const connect = jest
    .mocked(http2.connect)
    .mockImplementation(() =>
      actualConnect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  try {
    const data = Buffer.from([0, 0, 0, 0, 3, 1, 2, 3]);
    const result = await requestGrpcUpstream(
      'https://logging.googleapis.com/google.logging.v2.ConfigServiceV2/GetBucket',
      data,
      { authorization: 'Bearer temporary-google-token' },
      new AbortController().signal,
      [],
    );
    expect(Buffer.concat(received)).toEqual(data);
    expect(auth).toBe('Bearer temporary-google-token');
    expect(result.body).toEqual(Buffer.from([0, 0, 0, 0, 2, 8, 1]));
    expect(result.headers['grpc-status']).toBe('5');
    expect(result.headers['grpc-message']).toBe('not%20found');
    expect(result.isError).toBe(true);
  } finally {
    connect.mockReset();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a stalled unary upstream expires without replay and releases its HTTP/2 session', async () => {
  const server = http2.createServer();
  let calls = 0;
  server.on('stream', (stream) => {
    calls++;
    stream.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const actualConnect = jest.requireActual<typeof http2>('node:http2').connect;
  jest
    .mocked(http2.connect)
    .mockImplementation(() =>
      actualConnect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  try {
    await expect(
      requestGrpcUpstream(
        'https://logging.googleapis.com/stall',
        Buffer.alloc(0),
        {},
        new AbortController().signal,
        [],
        50,
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
    expect(calls).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
