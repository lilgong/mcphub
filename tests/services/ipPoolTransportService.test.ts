import { ipPoolConnectionOptions } from '../../src/services/ipPoolTransportService.js';

const before = { ...process.env };
afterEach(() => {
  process.env = { ...before };
});
function configure() {
  Object.assign(process.env, {
    IPWO_PROXY_HOST: 'proxy.example',
    IPWO_PROXY_PORT: '8080',
    IPWO_PROXY_USERNAME: 'test_zone_US',
    IPWO_PROXY_PASSWORD: 'p@ss:word',
  });
  delete process.env.IPWO_PROXY_COUNTRY;
}
test('pool forwarding fails closed when incomplete and leaves direct traffic untouched', () => {
  delete process.env.IPWO_PROXY_PASSWORD;
  expect(ipPoolConnectionOptions('https://huggingface.co')).toEqual({});
  expect(() => ipPoolConnectionOptions('https://huggingface.co', 'ip-pool')).toThrow('incomplete');
  configure();
  expect(() => ipPoolConnectionOptions('http://huggingface.co', 'ip-pool')).toThrow('HTTPS');
});
test('separates proxy authentication from target headers and does not pin rotating exits', () => {
  configure();
  const a = ipPoolConnectionOptions('https://huggingface.co', 'ip-pool').httpsAgent!;
  const b = ipPoolConnectionOptions('https://huggingface.co', 'ip-pool').httpsAgent!;
  expect(a).not.toBe(b);
  expect(a.keepAlive).toBe(false);
  expect(a.proxy.hostname).toBe('proxy.example');
  expect(decodeURIComponent(a.proxy.username)).toBe('test_zone_US');
  expect(decodeURIComponent(a.proxy.password)).toBe('p@ss:word');
  a.destroy();
  b.destroy();
});
