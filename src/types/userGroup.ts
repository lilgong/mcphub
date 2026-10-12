export interface UserGroupResource {
  name: string;
  /** Omitted means all targets; an empty list grants no target connections. */
  targets?: string[];
}

export interface UserGroup {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  owner: string;
  servers: UserGroupResource[];
}

/** Selector metadata only; excludes provider credentials, commands and task leases. */
export interface UserGroupResourceOption {
  name: string;
  enabled: boolean;
  targets: { path: string; kind: 'static' | 'task'; enabled: boolean }[];
}
