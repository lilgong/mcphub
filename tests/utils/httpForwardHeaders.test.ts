import {
  forwardingRequestHeaders,
  forwardingResponseHeaders,
  forwardingLocation,
} from '../../src/utils/httpForwardHeaders.js';

test('business headers survive while connection and Hub/client credentials stay isolated', () => {
  expect(
    forwardingRequestHeaders(
      {
        authorization: 'Bearer hub-key',
        'x-api-key': 'client-key',
        cookie: 'client-cookie',
        'x-auth-token': 'dashboard-token',
        'x-mcphub-run-token': 'run-token',
        connection: 'X-Private-Hop',
        'x-private-hop': 'private',
        'idempotency-key': 'mutation-a',
        'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
        'x-amz-security-token': 'sdk-session',
        'if-match': 'revision',
        'if-unmodified-since': 'date',
        'content-md5': 'checksum',
        'x-upload-content-type': 'image/png',
        'x-goog-user-project': 'project',
        'content-encoding': 'gzip',
        'content-length': '500',
        'x-custom-business': 'business',
      },
      { Authorization: 'Bearer upstream-key', 'X-API-KEY': 'operator-key' },
    ),
  ).toEqual({
    authorization: 'Bearer upstream-key',
    'x-api-key': 'operator-key',
    'idempotency-key': 'mutation-a',
    'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
    'x-amz-security-token': 'sdk-session',
    'if-match': 'revision',
    'if-unmodified-since': 'date',
    'content-md5': 'checksum',
    'x-upload-content-type': 'image/png',
    'x-goog-user-project': 'project',
    'content-encoding': 'gzip',
    'content-length': '500',
    'x-custom-business': 'business',
  });
});

test('response metadata retains encoding, range, digest and redirect; strips cookies and hop headers', () => {
  expect(
    forwardingResponseHeaders({
      'content-encoding': 'gzip',
      'content-length': '100',
      'content-range': 'bytes 0-99/200',
      location: '/next',
      digest: 'sha-256=checksum',
      'x-custom-result': 'ok',
      connection: 'X-Hop',
      'x-hop': 'private',
      'set-cookie': ['secret=1'],
      'cache-control': 'public',
      unused: null,
    }),
  ).toEqual({
    'content-encoding': 'gzip',
    'content-length': '100',
    'content-range': 'bytes 0-99/200',
    location: '/next',
    digest: 'sha-256=checksum',
    'x-custom-result': 'ok',
  });
});

test.each([
  ['/base/next?x=%252F', '/http/service/next?x=%252F'],
  ['next', '/http/service/next'],
  ['https://api.example/base', '/http/service'],
  ['https://other.example/object', 'https://other.example/object'],
  ['/outside', 'https://api.example/outside'],
  ['/base-other/object', 'https://api.example/base-other/object'],
])('redirect %s preserves the configured origin/prefix boundary', (location, expected) => {
  expect(
    forwardingLocation(
      location,
      'https://api.example/base/search',
      'https://api.example/base',
      '/http/service',
    ),
  ).toBe(expected);
});
