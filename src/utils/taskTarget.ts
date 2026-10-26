import type { TargetConnection } from '../types/targetConnection.js';

/** A task-only MCP needs a task identity, not a fixture selector. */
export const DEFAULT_TASK_TARGET = 'task/default';
export function resolveTaskTarget(
  targets: TargetConnection[] | undefined,
  requested?: string,
): TargetConnection | undefined {
  if (requested !== undefined)
    return targets?.find((target) => target.path === requested && target.kind === 'task');
  if (
    targets?.length === 1 &&
    targets[0].kind === 'task' &&
    targets[0].path === DEFAULT_TASK_TARGET
  )
    return targets[0];
  return undefined;
}
