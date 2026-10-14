import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
/** Local hashing works on private HTTP deployments too; raw keys never enter requests. */
export function credentialFingerprint(value: string): string {
  return bytesToHex(
    sha256(new TextEncoder().encode(value.trim().replace(/^Bearer\s+/i, ''))),
  ).slice(0, 16);
}
