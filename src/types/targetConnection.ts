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
  enabled?: boolean;
  implementation?: 'native' | 'wrapper' | 'custom';
  /** Operator-declared version or revision; never used to select an executable. */
  version?: string;
  /** Explicit names in the server environment to deliver to an authorized task worker. */
  startupEnvKeys?: string[];
  /** Operator-approved callback origins; these may use private worker addresses. */
  callbackOrigins?: string[];
  allowedKeyIds?: string[];
  allowedUsers?: string[];
  config?: TargetConnectionConfig;
}
export interface InvocationLabels {
  target?: string;
  taskId?: string;
}
