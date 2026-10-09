import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
describe('Context7 fetch preload', () => {
  test('preserves response status/body and redirects only Context7 reads through the local capability', () => {
    const script = `
      const assert = require('node:assert/strict');
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url) === process.env.MCPHUB_KEY_POOL_URL) return new Response(JSON.stringify({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"results":[1]}' }));
        return new Response('public');
      };
      require(${JSON.stringify(resolve('scripts/key_pool_fetch_preload.cjs'))});
      (async () => {
        const response = await fetch('https://context7.com/api/v2/search?query=react', { headers: { Authorization: 'Bearer placeholder' } });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { results: [1] });
        assert.equal(calls[0].url, process.env.MCPHUB_KEY_POOL_URL);
        assert.equal(calls[0].init.headers.Authorization, 'Bearer test-capability');
        assert.equal(JSON.parse(calls[0].init.body).url, 'https://context7.com/api/v2/search?query=react');
        assert.equal(await (await fetch('https://example.org')).text(), 'public');
        await assert.rejects(fetch('https://context7.com/api/write', { method: 'POST' }), /read-only/);
      })().catch(() => { process.exitCode = 1; });
    `;
    execFileSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        MCPHUB_KEY_POOL_URL: 'http://127.0.0.1/internal/v1/key-pool/context7',
        MCPHUB_KEY_POOL_TOKEN: 'test-capability',
      },
    });
  });
});
