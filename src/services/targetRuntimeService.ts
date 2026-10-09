import type { ServerConfig, ServerInfo } from '../types/index.js';
import type { RequestPrincipal } from './authorizationService.js';
import type { TargetConnection } from '../types/targetConnection.js';
import { validateTargetPath } from '../utils/targetConnection.js';
import { expandServerConfig } from './serverConfigEnvironment.js';
import { randomUUID } from 'node:crypto';
import type { RuntimeInstance } from '../types/serverRuntime.js';
export function authorizeTarget(
  target: TargetConnection,
  principal: RequestPrincipal | null | undefined,
  keyId?: string,
): boolean {
  if (!principal?.username || target.enabled === false) return false;
  if (target.allowedKeyIds?.length || target.allowedUsers?.length)
    return !!(
      (keyId && target.allowedKeyIds?.includes(keyId)) ||
      target.allowedUsers?.includes(principal.username)
    );
  return principal.isAdmin === true;
}
interface Entry {
  id: string;
  implementation?: TargetConnection['implementation'];
  configuredVersion?: string;
  startedAt: number;
  promise: Promise<ServerInfo>;
  active: number;
  timer?: NodeJS.Timeout;
  revision: string;
  server: string;
  target: string;
  info?: ServerInfo;
}
function resolveTargetConfig(definition: ServerConfig, target: TargetConnection): ServerConfig {
  // Targets supply their own transport and credentials. Inherit shared controls explicitly.
  return {
    ...target.config,
    enabled: definition.enabled !== false,
    description: definition.description ?? undefined,
    tools: definition.tools ?? undefined,
    prompts: definition.prompts ?? undefined,
    resources: definition.resources ?? undefined,
    relay: target.config?.relay ?? definition.relay ?? undefined,
    rateLimit: definition.rateLimit ?? undefined,
    perSessionClient: false,
    env: { ...target.config?.env, MCPHUB_CONNECTION_TARGET: target.path },
    owner: definition.owner,
    visibility: definition.visibility ?? 'private',
    sharedWithUsers: definition.sharedWithUsers?.length ? definition.sharedWithUsers : undefined,
  };
}
const targetRevision = (definition: ServerConfig, target: TargetConnection): string =>
  JSON.stringify([resolveTargetConfig(definition, target), target.implementation, target.version]);
/** Independent upstream clients per exact target. No configuration changes to global clients. */
export class TargetRuntimeService {
  private entries = new Map<string, Entry>();
  // Replaced connections stay visible while an in-flight call holds them.
  private liveEntries = new Set<Entry>();
  constructor(
    private connect: (name: string, config: ServerConfig) => Promise<ServerInfo>,
    private close: (info: ServerInfo) => void,
    private loadDefinition?: (name: string) => Promise<ServerConfig | undefined | null>,
  ) {}
  snapshot(server: string): RuntimeInstance[] {
    const current = new Set(this.entries.values());
    return [...this.liveEntries]
      .filter((entry) => entry.server === server)
      .map((entry) => ({
        id: entry.id,
        kind: 'target',
        target: entry.target,
        implementation: entry.implementation,
        configuredVersion: entry.configuredVersion,
        reportedVersion: entry.info?.version,
        packageVersion: entry.info?.packageVersion,
        status: entry.info?.status ?? 'connecting',
        startedAt: entry.startedAt,
        activeCalls: entry.active,
        draining: !current.has(entry),
      }));
  }
  private closeEntry(entry: Entry, info: ServerInfo): void {
    if (!this.liveEntries.delete(entry)) return;
    this.close(info);
  }
  invalidate(server?: string, nextDefinition?: ServerConfig): void {
    for (const [key, entry] of this.entries) {
      if (server && entry.server !== server) continue;
      const next = nextDefinition?.targets?.find((target) => target.path === entry.target);
      if (
        nextDefinition &&
        nextDefinition.enabled !== false &&
        next?.enabled !== false &&
        next?.kind === 'static' &&
        targetRevision(nextDefinition, next) === entry.revision
      )
        continue;
      this.entries.delete(key);
      clearTimeout(entry.timer);
      void entry.promise
        .then((info) => {
          if (!entry.active) this.closeEntry(entry, info);
        })
        .catch(() => undefined);
    }
  }
  async acquire(
    server: string,
    definition: ServerConfig,
    path: string | undefined,
    principal: RequestPrincipal | null | undefined,
    keyId?: string,
  ): Promise<{ info: ServerInfo; release: () => void }> {
    if (this.loadDefinition) {
      const current = await this.loadDefinition(server);
      if (!current || current.enabled === false) throw new Error('Target registration unavailable');
      definition = current;
    }
    if (!validateTargetPath(path)) throw new Error('An explicit X-MCPHub-Target is required');
    const target = definition.targets?.find((value) => value.path === path);
    if (!target || !authorizeTarget(target, principal, keyId))
      throw new Error('Target not available for this caller');
    if (target.kind !== 'static')
      throw new Error('Task targets require a registered task connection');
    const revision = targetRevision(definition, target);
    const key = JSON.stringify([server, path]);
    let entry = this.entries.get(key);
    if (entry && (entry.revision !== revision || entry.info?.status === 'disconnected')) {
      this.entries.delete(key);
      const old = entry;
      void old.promise
        .then((info) => {
          if (!old.active) this.closeEntry(old, info);
        })
        .catch(() => undefined);
      entry = undefined;
    }
    if (!entry) {
      const resolved = resolveTargetConfig(definition, target);
      entry = {
        id: randomUUID(),
        startedAt: Date.now(),
        implementation: target.implementation,
        configuredVersion: target.version,
        active: 0,
        revision,
        server,
        target: path,
        promise: (async () => this.connect(server, await expandServerConfig(resolved)))(),
      };
      this.entries.set(key, entry);
      this.liveEntries.add(entry);
      const created = entry;
      void created.promise
        .then((info) => {
          created.info = info;
        })
        .catch(() => undefined);
      created.promise.catch(() => {
        if (this.entries.get(key) === created) this.entries.delete(key);
        this.liveEntries.delete(created);
      });
    }
    clearTimeout(entry.timer);
    entry.active++;
    const held = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      held.active--;
      if (!held.active) {
        if (this.entries.get(key) !== held) {
          void held.promise.then((info) => this.closeEntry(held, info)).catch(() => undefined);
          return;
        }
        held.timer = setTimeout(() => {
          if (this.entries.get(key) === held && !held.active) {
            this.entries.delete(key);
            void held.promise.then((info) => this.closeEntry(held, info)).catch(() => undefined);
          }
        }, 300000);
        held.timer.unref?.();
      }
    };
    try {
      return { info: await held.promise, release };
    } catch (error) {
      release();
      throw error;
    }
  }
}
