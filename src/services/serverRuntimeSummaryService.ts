import type { TargetConnection } from '../types/targetConnection.js';
import type { RuntimeInstance, ServerRuntimeSummary } from '../types/serverRuntime.js';

const running = (instance: RuntimeInstance) =>
  instance.status === 'connected' || instance.status === 'registered';

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
