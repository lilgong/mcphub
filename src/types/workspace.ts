/** Operator-owned account material. Values/files never appear in discovery responses. */
export interface WorkspaceCredentials {
  catalog: string;
  name: string;
  allowedGroupIds: string[];
  values: Record<string, string>;
  files: Record<string, string>;
  connections?: Record<string, Record<string, string>>;
  revision: string;
}
export interface WorkspaceRun {
  id: string;
  catalog: string;
  workspace: string;
  owner: string;
  tokenHash: string;
  expiresAt: number;
}

export interface WorkspaceCredentialField {
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
  enabled?: boolean;
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
export interface WorkspaceSummary {
  catalog: string;
  name: string;
  allowedGroupIds: string[];
  revision: string;
  fields: string[];
  files: string[];
  connections: Record<string, Record<string, string>>;
  busy: boolean;
  expired?: boolean;
}
