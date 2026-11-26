import type { TargetConnection } from '../types/targetConnection.js';
import type { WorkspaceCredentialSchema } from '../types/workspace.js';

/** Task adapters own executable versions; account editing requires declared inputs. */
export function supportsAccountConfiguration(definition: {
  targets?: TargetConnection[];
  workspaceSchema?: WorkspaceCredentialSchema;
}): boolean {
  if (!definition.targets?.some((target) => target.kind === 'task')) return true;
  return !!(
    definition.workspaceSchema?.values?.length || definition.workspaceSchema?.files?.length
  );
}
