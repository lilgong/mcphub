import type { TargetConnection } from '../types/targetConnection.js';
import type { RuntimeInstance, ServerRuntimeSummary } from '../types/serverRuntime.js';
import type { ServerInfo } from '../types/index.js';

const running = (instance: RuntimeInstance) =>
  instance.status === 'connected' || instance.status === 'registered';

/** A logical MCP is online when at least one enabled target is ready. */
export function summarizeTargetServerStatus(
  targets: TargetConnection[],
  instances: RuntimeInstance[],
  enabled = true,
): ServerInfo['status'] {
  if (!enabled) return 'disconnected';
  const activeTargets = targets.filter((target) => target.enabled !== false);
  const current = instances.filter(
    (entry) =>
      !entry.draining &&
      activeTargets.some(
        (target) =>
          target.path === entry.target &&
          entry.kind === (target.kind === 'task' ? 'task' : 'target'),
      ),
  );
  if (current.some(running)) return 'connected';
  if (
    current.some((entry) => entry.status === 'connecting') ||
    activeTargets.some(
      (target) =>
        target.kind === 'static' && !current.some((entry) => entry.target === target.path),
    )
  )
    return 'connecting';
  if (current.some((entry) => entry.status === 'oauth_required')) return 'oauth_required';
  return 'disconnected';
}

/** Counting connections is deliberately independent of processes and Docker containers. */
export function summarizeServerRuntime(
  targets: TargetConnection[] | undefined,
  instances: RuntimeInstance[],
  enabled = true,
): ServerRuntimeSummary {
  instances = instances.map((entry) => {
    if (entry.kind !== 'task') return entry;
    const target = targets?.find(
      (target) => target.path === entry.target && target.kind === 'task',
    );
    return !enabled || !target || target.enabled === false
      ? { ...entry, status: 'disconnected' as const }
      : entry;
  });
  return {
    running: instances.filter(running).length,
    starting: instances.filter((entry) => entry.status === 'connecting').length,
    targets: (targets ?? []).map((target) => {
      const connections = instances.filter((entry) => entry.target === target.path);
      return {
        path: target.path,
        kind: target.kind,
        enabled: target.enabled !== false,
        implementation: target.implementation,
        configuredVersion: target.version,
        running: connections.filter(running).length,
        starting: connections.filter((entry) => entry.status === 'connecting').length,
      };
    }),
    instances,
  };
}
