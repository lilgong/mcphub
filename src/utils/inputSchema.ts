/** Preserve the upstream schema dialect and constraints at the MCP boundary. */
export function copyInputSchema<T>(schema: T): T {
  return schema && typeof schema === 'object' ? { ...schema } : schema;
}
