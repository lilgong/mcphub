import type { WorkspaceCredentials, WorkspaceCredentialSchema } from '../types/workspace.js';

/** Disabled declarations retain saved secrets but do not supply them to new runs. */
export function selectWorkspaceMaterial(
  workspace: WorkspaceCredentials,
  schemas: WorkspaceCredentialSchema[],
) {
  const valueFields = new Set(
    schemas.flatMap((schema) => schema.values?.map((field) => field.name) ?? []),
  );
  const enabledValues = new Set(
    schemas
      .filter((schema) => schema.enabled)
      .flatMap((schema) => schema.values?.map((field) => field.name) ?? []),
  );
  const includes = (schema: WorkspaceCredentialSchema, path: string) =>
    schema.files?.some((file) =>
      file.directory ? path.startsWith(file.path + '/') : path === file.path,
    );
  return {
    values: Object.fromEntries(
      Object.entries(workspace.values).filter(
        ([name]) => !valueFields.has(name) || enabledValues.has(name),
      ),
    ),
    files: Object.fromEntries(
      Object.entries(workspace.files).filter(
        ([path]) =>
          !schemas.some((schema) => includes(schema, path)) ||
          schemas.some((schema) => schema.enabled && includes(schema, path)),
      ),
    ),
  };
}
