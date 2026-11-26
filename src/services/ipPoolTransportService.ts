import { randomInt } from 'node:crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';

export type HttpEgress = 'ip-pool';

/** Keep pool credentials in Hub; HTTPS CONNECT preserves end-to-end upstream auth and bytes. */
export function ipPoolConnectionOptions(url: string, egress?: HttpEgress) {
  if (!egress) return {};
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('IP pool forwarding requires HTTPS');
  const host = process.env.IPWO_PROXY_HOST?.trim();
  const port = Number(process.env.IPWO_PROXY_PORT);
  let username = process.env.IPWO_PROXY_USERNAME?.trim();
  const password = process.env.IPWO_PROXY_PASSWORD;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !username || !password)
    throw new Error('IP pool configuration is incomplete');
  if (/[\s/@?#]/.test(host)) throw new Error('Invalid IP pool host');
  const country = process.env.IPWO_PROXY_COUNTRY?.trim().toUpperCase();
  if (country) username = username.replace(/_zone_[^_]+/, `_zone_${country}`);
  // Match Relay's rotation policy without introducing sticky sessions for rotating accounts.
  username = username.replace(/_sid_[^_]+/, `_sid_${randomInt(10_000_000, 100_000_000)}`);
  const proxy = new URL(`http://${host}:${port}`);
  proxy.username = username;
  proxy.password = password;
  // One agent per admitted request prevents keep-alive reuse from pinning rotating exits.
  return { httpsAgent: new HttpsProxyAgent(proxy, { keepAlive: false }) };
}
