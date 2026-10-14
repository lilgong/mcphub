import { createHash } from 'node:crypto';
import { credentialFingerprint } from '../../frontend/src/utils/credentialFingerprint';
import { upstreamCredential } from '../../src/utils/upstreamCredential';
it.each(['api-key-a', 'Bearer api-key-a', ' 上游密钥🙂 ', 'a'.repeat(1000)])(
  'matches logged fingerprints for %s',
  (value) => {
    const normalized = value.trim().replace(/^Bearer\s+/i, '');
    expect(credentialFingerprint(value)).toBe(
      createHash('sha256').update(normalized).digest('hex').slice(0, 16),
    );
    expect(upstreamCredential(value, 'authorization').id).toBe(credentialFingerprint(value));
  },
);
