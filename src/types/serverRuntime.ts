import type { TargetConnection } from './targetConnection.js';

/** Metadata only: never expose transport URLs, commands, credentials or lease tokens. */
export interface RuntimeInstance {
  id: string;
  kind: 'shared' | 'target' | 'task' | 'personal' | 'session';
  target?: string;
  implementation?: TargetConnection['implementation'];
  configuredVersion?: string;
  reportedVersion?: string;
  packageVersion?: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'oauth_required' | 'registered';
  startedAt?: number;
  activeCalls?: number;
  worker?: string;
  draining?: boolean;
  taskId?: string;
  expiresAt?: number;
}

export interface TargetRuntimeSummary {
  path: string;
  kind: TargetConnection['kind'];
  enabled: boolean;
  implementation?: TargetConnection['implementation'];
  configuredVersion?: string;
  running: number;
  starting: number;
}

export interface ServerRuntimeSummary {
  running: number;
  starting: number;
  targets: TargetRuntimeSummary[];
  instances: RuntimeInstance[];
}
