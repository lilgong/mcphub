import type { GithubPoolSnapshot } from './githubPool.js';
import type { TargetConnection } from './targetConnection.js';

export type WorkspaceServerConnection = Omit<TargetConnection, 'path' | 'kind'>;
/** Operator-owned account material. Values/files never appear in discovery responses. */
export interface WorkspaceCredentials {
  catalog: string;
  name: string;
  enabled?: boolean;
  allowedGroupIds: string[];
  values: Record<string, string>;
  files: Record<string, string>;
  connections?: Record<string, Record<string, string>>;
  serverConnections?: Record<string, WorkspaceServerConnection>;
  revision: string;
}
export interface WorkspaceRun {
  githubPool?: GithubPoolSnapshot;
  id: string;
  catalog: string;
  workspace: string;
  owner: string;
  tokenHash: string;
  expiresAt: number;
  startedAt?: number;
  heartbeatAt?: number;
  lastSyncAt?: number;
  state?: 'running' | 'recovery_required';
  lastError?: WorkspaceRunError;
}
export type WorkspaceRunError = 'sync_failed' | 'connection_failed' | 'cleanup_failed';
export type WorkspaceExitReason = 'completed' | 'cancelled' | 'command_failed' | 'startup_failed';
export interface WorkspaceRunSummary {
  id: string;
  startedAt?: number;
  heartbeatAt?: number;
  lastSyncAt?: number;
  expiresAt: number;
  state: 'running' | 'recovery_required';
  lastError?: WorkspaceRunError;
  endedAt?: number;
  exitReason?: WorkspaceExitReason | 'administrator_recovery';
}

export interface WorkspaceCredentialField {
  required?: boolean;
  name: string;
  label?: string;
  description?: string;
  secret?: boolean;
  env?: string;
  multiline?: boolean;
  /** Non-secret defaults only. */
  default?: string;
}
export interface WorkspaceCredentialFile {
  required?: boolean;
  path: string;
  label?: string;
  description?: string;
  directory?: boolean;
  format?: 'json' | 'env' | 'text';
  template?: string;
  fields?: WorkspaceCredentialField[];
}
/** Metadata only: declares account inputs and public defaults, never credentials. */
export interface WorkspaceCredentialSchema {
  /** Fixed upstreams for preparation/grading; credentials are resolved inside Hub. */
  http?: WorkspaceHttpBinding[];
  enabled?: boolean;
  /** Resident MCPs keep their launch configuration together with each account. */
  connection?: boolean;
  values?: WorkspaceCredentialField[];
  files?: WorkspaceCredentialFile[];
  /** Documentation only; never exported as credential values. */
  managed?: {
    name: string;
    source: 'task' | 'generated' | 'default';
    description: string;
    default?: string;
  }[];
}
export interface WorkspaceHttpBinding {
  id: string;
  url: string;
  protocol?: 'http' | 'grpc';
  streaming?: boolean;
  egress?: 'ip-pool';
  assetHosts?: string[];
  responseError?: { field: string; mode: 'false' | 'nonempty-array' };
  credential: {
    value?: string;
    file?: string;
    field?: string;
    forward?: boolean;
    header: string;
    prefix?: string;
    username?: string;
  };
  headers?: Record<string, string>;
}
export interface WorkspaceSummary {
  enabled?: boolean;
  ready?: boolean;
  missing?: string[];
  catalog: string;
  name: string;
  allowedGroupIds: string[];
  revision: string;
  fields: string[];
  files: string[];
  connections: Record<string, Record<string, string>>;
  servers?: string[];
  busy: boolean;
  expired?: boolean;
  run?: WorkspaceRunSummary;
  lastRun?: WorkspaceRunSummary;
}
