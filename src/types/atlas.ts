export interface ToolCallPolicy {
  enabled: boolean;
  concurrency: number;
  minIntervalMs: number;
  maxQueued: number;
  queueTimeoutMs: number;
  rateLimitBackoffMs: number;
  maxBackoffMs: number;
  scope: 'server' | 'principal';
}

export interface AtlasConfig {
  policies: Record<string, ToolCallPolicy>;
  relay: { enabled: boolean; url: string; timeoutSeconds: number };
}
