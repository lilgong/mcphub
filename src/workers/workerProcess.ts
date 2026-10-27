import { accessSync, constants } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import type { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/** Docker execution workers use util-linux setsid to establish an owned group. */
export function workerSessionCommand(): string {
  if (process.platform !== 'linux')
    throw new Error('MCP execution workers require Linux with setsid');
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, 'setsid');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Next PATH directory. */
    }
  }
  throw new Error('MCP execution workers require the util-linux setsid executable');
}

const GRACE_MS = 1000;
function signalGroup(group: number, signal: NodeJS.Signals): void {
  if (group <= 1 || group === process.pid) throw new Error('Invalid MCP process group');
  try {
    process.kill(-group, signal);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH')
      throw error;
  }
}

interface ProcessIdentity {
  pid: number;
  parent: number;
  start: string;
}
async function identity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return;
    return { pid, parent: Number(fields[1]), start: fields[19] };
  } catch {
    return;
  }
}
async function descendants(root: number): Promise<ProcessIdentity[]> {
  const processes: ProcessIdentity[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const current = await identity(Number(entry));
    if (current) processes.push(current);
  }
  const selected = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const current of processes)
      if (!selected.has(current.pid) && selected.has(current.parent)) {
        selected.add(current.pid);
        changed = true;
      }
  }
  return processes.filter((current) => selected.has(current.pid));
}
async function signalIdentities(
  processes: ProcessIdentity[],
  signal: NodeJS.Signals,
): Promise<void> {
  for (const recorded of processes.slice().reverse()) {
    const current = await identity(recorded.pid);
    // Do not signal a PID that has since been reused by another MCP.
    if (current?.start !== recorded.start) continue;
    try {
      process.kill(recorded.pid, signal);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH')
        throw error;
    }
  }
}

/** Keep the saved group ID even after the MCP leader exits or is reparented. */
export async function closeWorkerProcess(
  transport?: StdioClientTransport,
  group?: number,
): Promise<void> {
  if (!transport) return;
  if (!group) {
    await transport.close();
    return;
  }
  // Snapshot before TERM reparents descendants, including children that started
  // their own sessions. The group additionally catches newly forked members.
  const recorded = await descendants(group);
  signalGroup(group, 'SIGTERM');
  await signalIdentities(recorded, 'SIGTERM');
  const closed = transport.close();
  await new Promise<void>((resolve) => setTimeout(resolve, GRACE_MS));
  // Always escalate the entire group, including descendants of an exited leader.
  signalGroup(group, 'SIGKILL');
  await signalIdentities(recorded, 'SIGKILL');
  await closed;
}
