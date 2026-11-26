import {
  workspaceHttpSecret,
  workspaceHttpUrl,
  workspaceHttpResult,
} from '../../src/utils/workspaceHttp.js';
import { forwardingUrl } from '../../src/services/httpForwardService.js';
import type { WorkspaceCredentials, WorkspaceHttpBinding } from '../../src/types/workspace.js';

test('SDK bindings resolve only the selected account file and public endpoint label', () => {
  const account: WorkspaceCredentials = {
    catalog: 'bench',
    name: 'account-a',
    revision: 'r',
    allowedGroupIds: [],
    values: { account: 'org_account' },
    files: { 'configs/service.json': '{"private_key":"private-a"}' },
  };
  const binding: WorkspaceHttpBinding = {
    id: 'sdk',
    url: 'https://${account}.snowflakecomputing.com',
    credential: {
      file: 'configs/service.json',
      field: 'private_key',
      header: 'Authorization',
      forward: true,
    },
  };
  expect(workspaceHttpUrl(binding, account)).toBe('https://org-account.snowflakecomputing.com/');
  expect(workspaceHttpSecret(binding, account)).toBe('private-a');
  expect(() =>
    workspaceHttpUrl(binding, { ...account, values: { account: 'attacker/path' } }),
  ).toThrow();
});

test('storage object names keep encoded slashes/percent signs; traversal stays blocked', () => {
  const path = '/storage/v1/b/bucket/o/folder%2F100%25file.csv';
  expect(forwardingUrl('https://storage.googleapis.com', path, '')).toBe(
    'https://storage.googleapis.com' + path,
  );
  expect(() => forwardingUrl('https://storage.googleapis.com', '/a/%2e%2e/secret', '')).toThrow();
});

test('declared JSON errors change audit outcome without modifying HTTP status or payload', () => {
  const response = {
    status: 200,
    isError: false,
    headers: {},
    body: Buffer.from('{"success":false}'),
  };
  const result = workspaceHttpResult({ field: 'success', mode: 'false' }, response);
  expect(result.isError).toBe(true);
  expect(result.status).toBe(200);
  expect(result.body).toBe(response.body);
});

test('asset allowlists and Basic credentials cannot disguise another account key', async () => {
  const { workspaceAssetHost, headerContainsCredential } = await import(
    '../../src/utils/workspaceHttp.js'
  );
  expect(workspaceAssetHost('bucket.s3.amazonaws.com', ['*.amazonaws.com'])).toBe(true);
  expect(workspaceAssetHost('bucket.s3.amazonaws.com.evil.test', ['*.amazonaws.com'])).toBe(false);
  expect(
    headerContainsCredential(
      'Basic ' + Buffer.from('api:account-secret').toString('base64'),
      'account-secret',
    ),
  ).toBe(true);
  expect(headerContainsCredential('Bearer ephemeral', 'account-secret')).toBe(false);
});

test('compressed JSON application errors are audited without changing wire bytes', async () => {
  const { gzipSync } = await import('node:zlib');
  const body = gzipSync('{"success":false}');
  const result = workspaceHttpResult(
    { field: 'success', mode: 'false' },
    {
      status: 200,
      isError: false,
      headers: { 'content-encoding': 'gzip' },
      body,
    },
  );
  expect(result.isError).toBe(true);
  expect(result.body).toBe(body);
});

test('Sheets range names allow encoded spaces without rewriting the path', () => {
  const path = '/v4/spreadsheets/test/values/%27Text%20and%20Image%27';
  expect(forwardingUrl('https://sheets.googleapis.com', path, '?majorDimension=ROWS')).toBe(
    'https://sheets.googleapis.com' + path + '?majorDimension=ROWS',
  );
  expect(forwardingUrl('https://sheets.googleapis.com/v4', '/values/Text and Image', '')).toBe(
    'https://sheets.googleapis.com/v4/values/Text%20and%20Image',
  );
});

test('space support does not admit control characters or traversal', () => {
  for (const path of [
    '/values/a%00b',
    '/values/a%09b',
    '/values/a%0Ab',
    '/values/a%0Db',
    '/a/%2e%2e/secret',
    '//evil.example/path',
    '/a%5Cb',
  ]) {
    expect(() => forwardingUrl('https://sheets.googleapis.com/v4', path, '')).toThrow();
  }
});

test.each([
  '/objects/folder%2F..%2Ffile.csv',
  '/objects/100%25.csv',
  '/objects/hello%3Fworld',
  '/objects/hello%23world',
  '/objects/%252e%252e',
  '/objects/literal%252Fname',
])('preserves encoded object data rather than recursively decoding it: %s', (path) => {
  expect(forwardingUrl('https://storage.googleapis.com/base', path)).toBe(
    'https://storage.googleapis.com/base' + path,
  );
});
