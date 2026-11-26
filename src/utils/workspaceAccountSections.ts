import type { WorkspaceCredentialSchema, WorkspaceSummary } from '../types/workspace.js';
import { splitServerKey } from './catalog.js';

export interface WorkspaceAccountSection {
  id: string;
  server: string;
  servers: string[];
  schema: WorkspaceCredentialSchema;
  configured: boolean;
}

export interface WorkspaceAccountDefinition {
  name: string;
  config: { workspaceSchema: WorkspaceCredentialSchema };
}

/** Server lists are summaries. Discover account declarations through the scoped metadata API. */
export async function loadWorkspaceAccountDefinitions(
  names: string[],
  load: (name: string) => Promise<{
    success: boolean;
    data?: { schema?: WorkspaceCredentialSchema };
    message?: string;
  }>,
): Promise<{ servers: WorkspaceAccountDefinition[]; failed: string[] }> {
  const queue = [...names];
  const servers: WorkspaceAccountDefinition[] = [];
  const failed: string[] = [];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        try {
          const result = await load(name);
          if (result.success && result.data?.schema)
            servers.push({ name, config: { workspaceSchema: result.data.schema } });
          else if (result.message !== 'Server has no startup account declaration')
            failed.push(name);
        } catch {
          failed.push(name);
        }
      }
    }),
  );
  return { servers, failed };
}

/** Group identical declared inputs; HTTP bindings do not create separate credentials. */
export function workspaceAccountSections(
  servers: { name: string; config?: { workspaceSchema?: WorkspaceCredentialSchema } }[],
  catalog: string,
  account?: Pick<WorkspaceSummary, 'fields' | 'files' | 'servers'>,
): WorkspaceAccountSection[] {
  const sections = new Map<string, WorkspaceAccountSection>();
  for (const server of [...servers].sort((a, b) => a.name.localeCompare(b.name))) {
    const schema = server.config?.workspaceSchema;
    if (splitServerKey(server.name).catalog !== catalog || !schema) continue;
    const values = (schema.values ?? []).map((field) => field.name).sort();
    const files = (schema.files ?? []).map((file) => [file.path, !!file.directory]).sort();
    if (!values.length && !files.length && !schema.connection) continue;
    const bindings = (schema.values ?? []).map((field) => [field.name, field.env || '']).sort();
    const id = schema.connection ? server.name : JSON.stringify([bindings, files]);
    const existing = sections.get(id);
    if (existing) {
      existing.servers.push(server.name);
      if (!existing.schema.enabled && schema.enabled) {
        existing.server = server.name;
        existing.schema = schema;
      }
      continue;
    }
    sections.set(id, {
      id,
      server: server.name,
      servers: [server.name],
      schema,
      configured:
        !!account &&
        (values.some((field) => account.fields.includes(field)) ||
          account.servers?.includes(splitServerKey(server.name).name) ||
          (schema.files ?? []).some((file) =>
            account.files.some((path) =>
              file.directory ? path.startsWith(file.path + '/') : path === file.path,
            ),
          )),
    });
  }
  return [...sections.values()];
}
