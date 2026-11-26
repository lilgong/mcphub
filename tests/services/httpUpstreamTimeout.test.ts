import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestHttpUpstream } from '../../src/services/httpForwardService.js';
jest.mock('../../src/utils/ssrf.js', () => ({
  assertSafeUrl: async () => undefined,
  ssrfConnectionOptions: () => ({}),
}));

test('buffered SDK responses retain finite upstream read protection after headers', async () => {
  const server = http.createServer((_req, response) => {
    response.writeHead(200);
    response.write('partial');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const abort = new AbortController();
  const fallback = setTimeout(() => abort.abort(), 1500);
  try {
    const before = Date.now();
    await expect(
      requestHttpUpstream(
        { options: { timeout: 60 } },
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/stall`,
        'GET',
        undefined,
        {},
        abort.signal,
        true,
      ),
    ).rejects.toThrow();
    expect(Date.now() - before).toBeLessThan(1000);
  } finally {
    clearTimeout(fallback);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
