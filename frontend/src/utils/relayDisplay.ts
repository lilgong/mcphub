import type { ServerConfig } from '../types';
import { supportsFetchRelay } from '../../../src/utils/relayCompatibility';

/** This describes configured routing, not proof that a particular HTTP request was forwarded. */
export function relayDisplay(
  config: Partial<ServerConfig> | undefined,
  ready: boolean,
): 'enabled' | 'task' | 'unavailable' | undefined {
  if (!config) return undefined;
  const targets = config.targets?.filter((target) => target.enabled !== false);
  if (targets?.length) {
    const relayTargets = targets.filter(
      (target) =>
        supportsFetchRelay(target.config ?? {}) && target.config?.relay?.enabled !== false,
    );
    if (!relayTargets.length) return undefined;
    if (!ready) return 'unavailable';
    return relayTargets.every((target) => target.kind === 'task') ? 'task' : 'enabled';
  }
  if (!supportsFetchRelay(config) || config.relay?.enabled === false) return undefined;
  return ready ? 'enabled' : 'unavailable';
}
