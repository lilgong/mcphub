import { generateKeyPairSync } from 'node:crypto';
import { normalizeCredentialPrivateKeys } from '../../src/utils/workspacePrivateKeys.js';

const pem = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

test('JSON-pasted PEM escapes become real newlines without modifying other credentials', () => {
  const original = { private_key: pem, token: 'literal\\nsecret', scopes: ['scope'] };
  const pasted = JSON.stringify({ ...original, private_key: pem.replace(/\n/g, '\\n') });
  expect(JSON.parse(normalizeCredentialPrivateKeys(pasted))).toEqual(original);
  const valid = JSON.stringify(original);
  expect(normalizeCredentialPrivateKeys(valid)).toBe(valid);
  expect(normalizeCredentialPrivateKeys(pem.replace(/\n/g, '\\n'))).toBe(pem);
  expect(normalizeCredentialPrivateKeys('ordinary\\nsecret')).toBe('ordinary\\nsecret');
});

test('malformed PEM is rejected without leaking its contents', () => {
  const invalid = '-----BEGIN PRIVATE KEY-----\nsecret-invalid-data\n-----END PRIVATE KEY-----';
  expect(() =>
    normalizeCredentialPrivateKeys(JSON.stringify({ nested: [{ key: invalid }] })),
  ).toThrow('Invalid PEM private key');
  try {
    normalizeCredentialPrivateKeys(invalid);
  } catch (error) {
    expect(String(error)).not.toContain('secret-invalid-data');
  }
});
