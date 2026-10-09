import type { KeyPoolConfig } from './keyPool.js';
import type { FetchRelayConfig } from './serviceControls.js';

/** Serializable connection DTO shared with the dashboard; no runtime dependencies. */
export interface TargetConnectionConfig {
  type?: 'stdio' | 'sse' | 'streamable-http';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  options?: {
    timeout?: number;
    resetTimeoutOnProgress?: boolean;
    maxTotalTimeout?: number;
    maxBufferSize?: number;
  };
  keyPool?: KeyPoolConfig;
  relay?: FetchRelayConfig;
}
/** Exact, required route selectors. Task destinations are registered by an operator at runtime. */
export interface TargetConnection {
  path: string;
  kind: 'static' | 'task';
  allowedKeyIds?: string[];
  allowedUsers?: string[];
  config?: TargetConnectionConfig;
}
export interface InvocationLabels {
  target?: string;
  model?: string;
  benchmark?: string;
  runId?: string;
  taskId?: string;
}
