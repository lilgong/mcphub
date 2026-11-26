/** Upstream idle budget; admission queues and client transport margins are separate. */
export function workspaceUpstreamTimeout(header?: string, configured?: number): number {
  const fallback = Number(process.env.MCPHUB_WORKSPACE_HTTP_TIMEOUT_MS || 300000);
  const valid = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
  if (!valid(fallback)) throw new Error('Invalid MCPHUB_WORKSPACE_HTTP_TIMEOUT_MS');
  const caller = header === undefined ? undefined : Number(header);
  if (header !== undefined && (!/^\d+$/.test(header) || !valid(caller!)))
    throw new Error('Invalid upstream timeout budget');
  const operator = configured && valid(configured) ? configured : undefined;
  return caller === undefined ? (operator ?? fallback) : Math.min(caller, operator ?? Infinity);
}
