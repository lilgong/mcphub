import { followGithubRestRedirects } from '../../src/services/githubRedirectService.js';
import type { ForwardResponse } from '../../src/services/httpForwardService.js';

const reply = (status: number, location?: string): ForwardResponse => ({
  status,
  isError: false,
  body: Buffer.alloc(0),
  headers: location ? { location } : {},
});

test('DELETE follows 307 to the repository ID via a separately scheduled request', async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce(reply(307, '/repositories/1438311668'))
    .mockResolvedValueOnce(reply(204));
  const result = await followGithubRestRedirects(
    'https://api.github.com/repos/owner/old',
    'DELETE',
    request,
  );
  expect(result.status).toBe(204);
  expect(request.mock.calls).toEqual([
    ['https://api.github.com/repos/owner/old'],
    ['https://api.github.com/repositories/1438311668'],
  ]);
});

test.each([
  'https://evil.example/repo',
  'http://api.github.com/repo',
  'https://api.github.com:444/repo',
  'https://user:secret@api.github.com/repo',
  'https://api.github.com.evil.example/repo',
])('refuses credential-bearing or foreign redirect %s', async (url) => {
  const request = jest.fn().mockResolvedValue(reply(307, url));
  await expect(
    followGithubRestRedirects('https://api.github.com/repos/a/b', 'DELETE', request),
  ).rejects.toThrow('denied');
  expect(request).toHaveBeenCalledTimes(1);
});

test('detects cycles and bounds unique redirect chains', async () => {
  const cycle = jest.fn().mockResolvedValue(reply(307, '/repos/a/b'));
  await expect(
    followGithubRestRedirects('https://api.github.com/repos/a/b', 'DELETE', cycle),
  ).rejects.toThrow('loop');
  let id = 0;
  const chain = jest.fn(async () => reply(307, `/repositories/${++id}`));
  await expect(
    followGithubRestRedirects('https://api.github.com/repos/a/b', 'DELETE', chain),
  ).rejects.toThrow('limit');
  expect(chain).toHaveBeenCalledTimes(6);
});

test('does not replay ordinary errors or ambiguous mutation redirects', async () => {
  for (const status of [302, 303, 403, 429, 500]) {
    const request = jest.fn().mockResolvedValue(reply(status, '/repositories/1'));
    expect(
      (await followGithubRestRedirects('https://api.github.com/repos/a/b', 'DELETE', request))
        .status,
    ).toBe(status);
    expect(request).toHaveBeenCalledTimes(1);
  }
});
