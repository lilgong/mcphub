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
  members: string[];
  servers: UserGroupResource[];
}
