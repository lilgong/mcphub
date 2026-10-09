/** Show a recognizable suffix while always keeping part of the credential hidden. */
export function keySuffix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '—';
  const count = Math.min(6, Math.max(0, trimmed.length - 1));
  return count ? `…${trimmed.slice(-count)}` : '…';
}
