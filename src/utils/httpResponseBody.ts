import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

/** Decode only a bounded diagnostic preview; never transform forwarded bytes. */
export function decodedHttpPreview(body: Buffer, encoding = ''): Buffer {
  const decode =
    encoding === 'gzip'
      ? gunzipSync
      : encoding === 'deflate'
        ? inflateSync
        : encoding === 'br'
          ? brotliDecompressSync
          : undefined;
  return decode ? decode(body, { maxOutputLength: 1024 * 1024 }) : body;
}
