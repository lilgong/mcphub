import axios from 'axios';
import { Readable, Writable } from 'node:stream';
import type { Request, Response } from 'express';
import { streamWorkspaceHttp } from '../../src/services/workspaceHttpStreamService.js';
jest.mock('../../src/utils/ssrf.js', () => ({
  assertSafeUrl: async () => undefined,
  ssrfConnectionOptions: () => ({}),
}));

test('large Git packs stream with bounded memory and retain content-length', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 1);
  const size = chunk.length * 80;
  const upstream = jest.spyOn(axios, 'request').mockResolvedValue({
    status: 200,
    headers: {
      'content-length': String(size),
      'content-type': 'application/x-git-upload-pack-result',
    },
    data: Readable.from(Array(80).fill(chunk)),
  });
  let bytes = 0;
  const headers: Record<string, string> = {};
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback();
    },
  });
  const res = Object.assign(sink, {
    status: () => res,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  });
  try {
    const result = await streamWorkspaceHttp(
      { method: 'GET' } as Request,
      res as unknown as Response,
      'https://github.com/owner/repo.git/git-upload-pack',
      {},
      new AbortController().signal,
      [],
    );
    expect(bytes).toBe(size);
    expect(headers['content-length']).toBe(String(size));
    expect(result.streamed).toBe(true);
    expect(upstream.mock.calls[0][0]).toMatchObject({
      responseType: 'stream',
      maxBodyLength: Infinity,
      decompress: false,
    });
  } finally {
    upstream.mockRestore();
    res.end();
  }
});

test('streaming downloads may exceed the read budget in total while progress continues', async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    let sent = 0;
    response.write('x');
    const timer = setInterval(() => {
      response.write('x');
      if (++sent === 6) {
        clearInterval(timer);
        response.end();
      }
    }, 30);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let bytes = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback();
    },
  });
  const res = Object.assign(sink, { status: () => res, setHeader: () => undefined });
  try {
    const before = Date.now();
    const result = await streamWorkspaceHttp(
      { method: 'GET' } as Request,
      res as unknown as Response,
      `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/file`,
      {},
      new AbortController().signal,
      [],
      undefined,
      { timeout: 100 },
    );
    expect(result.status).toBe(200);
    expect(Date.now() - before).toBeGreaterThan(150);
    expect(bytes).toBe(7);
  } finally {
    sink.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a stalled upstream cannot leave a streaming request waiting forever', async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, response) => {
    response.writeHead(200);
    response.write('first');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const res = Object.assign(sink, { status: () => res, setHeader: () => undefined });
  try {
    const before = Date.now();
    await expect(
      streamWorkspaceHttp(
        { method: 'GET' } as Request,
        res as unknown as Response,
        `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/stall`,
        {},
        new AbortController().signal,
        [],
        undefined,
        { timeout: 60 },
      ),
    ).rejects.toThrow();
    expect(Date.now() - before).toBeLessThan(1000);
  } finally {
    sink.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('IP pool streaming preserves upstream authorization, payload and finite read timeout', async () => {
  const env = { ...process.env };
  Object.assign(process.env, {
    IPWO_PROXY_HOST: 'proxy.example',
    IPWO_PROXY_PORT: '8080',
    IPWO_PROXY_USERNAME: 'test_zone_US',
    IPWO_PROXY_PASSWORD: 'pool-secret',
  });
  const upstream = jest.spyOn(axios, 'request').mockResolvedValue({
    status: 200,
    headers: {},
    data: Readable.from(['ok']),
  });
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const res = Object.assign(sink, { status: () => res, setHeader: () => undefined });
  try {
    await streamWorkspaceHttp(
      { method: 'DELETE', body: Buffer.from('{"name":"probe"}') } as Request,
      res as unknown as Response,
      'https://huggingface.co/api/repos/delete',
      { authorization: 'Bearer upstream-hf-key', 'content-type': 'application/json' },
      new AbortController().signal,
      [],
      undefined,
      { timeout: 120000, egress: 'ip-pool' },
    );
    const request = upstream.mock.calls[0][0];
    expect(request).toMatchObject({
      method: 'DELETE',
      timeout: 120000,
      proxy: false,
      maxRedirects: 0,
      headers: { authorization: 'Bearer upstream-hf-key' },
    });
    expect(request.httpsAgent).toBeDefined();
    expect(request.headers).not.toHaveProperty('proxy-authorization');
    const chunks = [];
    for await (const chunk of request.data as Readable) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('{"name":"probe"}');
  } finally {
    upstream.mockRestore();
    sink.end();
    process.env = env;
  }
});
