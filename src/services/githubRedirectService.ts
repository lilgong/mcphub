import type { ForwardResponse } from './httpForwardService.js';
import { captureToolDiagnostic } from './toolAuditService.js';

/** Follow REST redirects only inside GitHub's API origin, scheduling each HTTP hop. */
export async function followGithubRestRedirects(
  initialUrl: string,
  method: string,
  request: (url: string) => Promise<ForwardResponse>,
): Promise<ForwardResponse> {
  let url = initialUrl;
  const visited = new Set<string>([url]);
  const log = captureToolDiagnostic('');
  for (let redirects = 0; ; redirects++) {
    const result = await request(url);
    if (![301, 302, 307, 308].includes(result.status)) return result;
    // Never silently turn a mutation into a GET.
    if (result.status === 302 && !['GET', 'HEAD'].includes(method)) return result;
    if (!result.headers.location) return result;
    const next = new URL(result.headers.location, url);
    if (next.origin !== 'https://api.github.com' || next.username || next.password || next.hash)
      throw new Error('GitHub REST redirect destination denied');
    if (redirects >= 5 || visited.has(next.href))
      throw new Error('GitHub REST redirect limit or loop');
    log('github_redirect', {
      http_status: result.status,
      http_method: method,
      upstream_host: next.hostname,
      upstream_path: next.pathname.slice(0, 1000),
    });
    visited.add(next.href);
    url = next.href;
  }
}
