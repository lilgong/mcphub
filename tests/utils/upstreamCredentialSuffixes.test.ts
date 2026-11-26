import { upstreamCredentialSuffixes } from '../../src/utils/upstreamCredentialSuffixes.js';
import { upstreamCredential } from '../../src/utils/upstreamCredential.js';
test('matches historical fingerprints across environment, headers and target configurations without returning secrets', () => {
  const key = 'private-upstream-key-abcd';
  const id = upstreamCredential(key, '').id;
  const suffixes = upstreamCredentialSuffixes([
    {
      env: { API_KEY: key },
      targets: [{ config: { headers: { Authorization: `Bearer ${key}` } } }],
    },
  ]);
  expect(suffixes.get(id)).toBe('abcd');
  expect([...suffixes.values()]).not.toContain(key);
  expect(upstreamCredentialSuffixes({ env: { KEY: '${API_KEY}' } }).size).toBe(0);
});
