'use strict';
const upstreamFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== 'context7.com' || !url.pathname.startsWith('/api/')) return upstreamFetch(input, init);
  if (request.method !== 'GET') throw new Error('Key pool only supports read-only Context7 requests');
  const response = await upstreamFetch(process.env.MCPHUB_KEY_POOL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.MCPHUB_KEY_POOL_TOKEN}` },
    body: JSON.stringify({ url: request.url }),
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(60000)]),
  });
  if (!response.ok) throw new Error('Context7 key pool request failed');
  const result = await response.json();
  return new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status, headers: result.headers });
};
