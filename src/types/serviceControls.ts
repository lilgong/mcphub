/** Optional shared limits for an upstream MCP. Unset values impose no limit. */
export interface ServiceRateLimit {
  enabled: boolean;
  concurrency?: number;
  minIntervalMs?: number;
  maxCalls?: number;
  windowMs?: number;
  maxQueued?: number;
  queueTimeoutMs?: number;
  rateLimitBackoffMs?: number;
  maxBackoffMs?: number;
}

/** Opt into the managed relay for a compatible stdio wrapper. */
export interface FetchRelayConfig {
  enabled: boolean;
}
