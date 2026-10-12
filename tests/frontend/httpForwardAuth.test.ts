import {
  readHttpForwardAuth,
  suggestedHttpAuth,
  extraHttpHeaders,
  buildHttpAuthHeaders,
} from '../../frontend/src/utils/httpForwardAuth';

it('opens existing Bearer settings as a bare key and round-trips without changing credentials', () => {
  const headers = [
    { key: 'authorization', value: 'Bearer fixture-key-1234' },
    { key: 'Accept', value: 'application/json' },
  ];
  const auth = readHttpForwardAuth('https://yibuapi.com/serper', headers);
  expect(auth.key).toBe('fixture-key-1234');
  expect(buildHttpAuthHeaders(auth, extraHttpHeaders(headers, auth))).toEqual([
    { key: 'Accept', value: 'application/json' },
    { key: 'Authorization', value: 'Bearer fixture-key-1234' },
  ]);
});
it('moves the same bare key from Bearer to official Serper without leaving the old credential header', () => {
  const headers = [{ key: 'Authorization', value: 'Bearer fixture-key' }];
  const auth = readHttpForwardAuth('https://yibuapi.com/serper', headers);
  const next = { ...auth, mode: 'header' as const, headerName: 'X-API-KEY' };
  expect(buildHttpAuthHeaders(next, extraHttpHeaders(headers, auth))).toEqual([
    { key: 'X-API-KEY', value: 'fixture-key' },
  ]);
});
it('can disable managed authentication while retaining unrelated headers', () => {
  const headers = [
    { key: 'X-API-KEY', value: 'fixture-key' },
    { key: 'Accept', value: 'application/json' },
  ];
  const auth = readHttpForwardAuth('https://google.serper.dev', headers);
  expect(buildHttpAuthHeaders({ ...auth, mode: 'none' }, extraHttpHeaders(headers, auth))).toEqual([
    { key: 'Accept', value: 'application/json' },
  ]);
});
it('retains custom header authentication on reopening', () => {
  const headers = [{ key: 'X-Service-Token', value: 'fixture-key' }];
  const auth = readHttpForwardAuth('https://service.example', headers);
  expect(buildHttpAuthHeaders(auth, extraHttpHeaders(headers, auth))).toEqual(headers);
});
it('does not double-prefix a pasted Bearer credential', () => {
  expect(
    buildHttpAuthHeaders(
      { mode: 'bearer', key: ' Bearer Bearer fixture-key ', headerName: 'Authorization' },
      [],
    ),
  ).toEqual([{ key: 'Authorization', value: 'Bearer fixture-key' }]);
});
it('matches provider hosts exactly and permits manual configuration for other URLs', () => {
  expect(suggestedHttpAuth('https://google.serper.dev/')).toBe('header');
  expect(suggestedHttpAuth('https://yibuapi.com/serper')).toBe('bearer');
  expect(suggestedHttpAuth('https://google.serper.dev.evil.example/')).toBeUndefined();
  expect(suggestedHttpAuth('${SERPER_UPSTREAM_URL}')).toBeUndefined();
});
