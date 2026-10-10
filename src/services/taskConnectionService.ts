import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { InvocationLabels } from '../types/targetConnection.js';
import type { TargetConnection } from '../types/targetConnection.js';
import type { RuntimeInstance } from '../types/serverRuntime.js';
export interface TaskConnection extends InvocationLabels {
  id: string;
  server: string;
  taskId: string;
  target: string;
  owner: string;
  username: string;
  keyId?: string;
  url: string;
  upstreamToken: string;
  token: string;
  expiresAt: number;
  revoked: boolean;
  controllers: Set<AbortController>;
  createdAt?: number;
  implementation?: TargetConnection['implementation'];
  configuredVersion?: string;
}
/** Generic leased callback connections. URLs are accepted only from authenticated operators. */
export class TaskConnectionRegistry {
  private entries = new Map<string, TaskConnection>();
  register(
    input: Omit<TaskConnection, 'id' | 'token' | 'expiresAt' | 'revoked' | 'controllers'>,
    ttlSeconds = 300,
  ): TaskConnection {
    this.prune();
    if (this.entries.size >= 10000) throw new Error('Task connection capacity reached');
    if (
      [...this.entries.values()].some(
        (entry) =>
          entry.owner === input.owner &&
          entry.server === input.server &&
          entry.target === input.target &&
          entry.taskId === input.taskId,
      )
    )
      throw new Error('Task connection already exists');
    const entry = {
      ...input,
      createdAt: Date.now(),
      id: randomUUID(),
      token: randomBytes(32).toString('hex'),
      expiresAt: Date.now() + ttlSeconds * 1000,
      revoked: false,
      controllers: new Set<AbortController>(),
    };
    this.entries.set(entry.id, entry);
    return entry;
  }
  private prune() {
    for (const entry of this.entries.values())
      if (entry.expiresAt <= Date.now()) this.remove(entry.id, entry.owner);
  }
  snapshot(server: string): RuntimeInstance[] {
    this.prune();
    return [...this.entries.values()]
      .filter((entry) => entry.server === server)
      .map((entry) => ({
        id: entry.id,
        kind: 'task',
        target: entry.target,
        implementation: entry.implementation,
        configuredVersion: entry.configuredVersion,
        status: 'registered',
        startedAt: entry.createdAt,
        taskId: entry.taskId,
        expiresAt: entry.expiresAt,
        activeCalls: entry.controllers.size,
      }));
  }
  acquire(id: string, token: string): TaskConnection | undefined {
    this.prune();
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.revoked ||
      Buffer.byteLength(token) !== Buffer.byteLength(entry.token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(entry.token))
    )
      return undefined;
    return entry;
  }
  getOwnedResource(id: string, owner: string): { server: string; target: string } | undefined {
    this.prune();
    const entry = this.entries.get(id);
    return entry && entry.owner === owner
      ? { server: entry.server, target: entry.target }
      : undefined;
  }
  renew(id: string, owner: string, ttlSeconds = 300): boolean {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return false;
    entry.expiresAt = Date.now() + ttlSeconds * 1000;
    return true;
  }
  remove(id: string, owner: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return false;
    entry.revoked = true;
    for (const abort of entry.controllers) abort.abort();
    this.entries.delete(id);
    return true;
  }
}
export const taskConnections = new TaskConnectionRegistry();
