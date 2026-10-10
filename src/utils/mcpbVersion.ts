import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const version = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\r\n]/.test(value)
    ? value
    : undefined;

interface Metadata {
  manifest_version?: unknown;
  version?: unknown;
  server?: { entry_point?: unknown };
  kind?: unknown;
  source?: unknown;
  entrypoint?: unknown;
  pythonPackages?: Record<string, unknown>;
  primaryPackage?: string;
}

async function json(path: string): Promise<Metadata> {
  if ((await stat(path)).size > 512 * 1024) throw new Error('Metadata too large');
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Read installed bundle metadata only; never execute a launcher or query a registry. */
export async function resolveMcpbVersions(config?: {
  command?: string;
  args?: string[];
}): Promise<{ packageVersion?: string; bundleVersion?: string } | undefined> {
  if (!config?.command || basename(config.command) !== 'node' || !config.args?.[0]) return;
  const entry = resolve(config.args[0]);
  let root = dirname(entry);
  for (let depth = 0; depth < 4; depth++, root = dirname(root)) {
    try {
      const manifest = await json(join(root, 'manifest.json'));
      if (!manifest.manifest_version || !version(manifest.version)) continue;
      const declared = manifest.server?.entry_point;
      if (typeof declared !== 'string' || resolve(root, declared) !== entry) continue;
      const fallback = version(manifest.version);
      try {
        const runtime = await json(join(root, 'runtime.json'));
        if (runtime.kind === 'node' && typeof runtime.source === 'string') {
          const source = runtime.source;
          const packageName = source.includes('#')
            ? source.split('#')[0]
            : source.lastIndexOf('@') > 0
              ? source.slice(0, source.lastIndexOf('@'))
              : source;
          if (!/^(@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(packageName))
            return { bundleVersion: fallback };
          const path = resolve(root, 'server/node_modules', packageName, 'package.json');
          if (relative(root, path).startsWith('..' + sep)) return { bundleVersion: fallback };
          return { packageVersion: version((await json(path)).version), bundleVersion: fallback };
        }
        if (runtime.kind === 'python') {
          const distribution =
            runtime.primaryPackage ??
            (typeof runtime.entrypoint === 'string'
              ? basename(runtime.entrypoint).toLowerCase().replace(/[_.]+/g, '-')
              : undefined);
          return {
            packageVersion: distribution
              ? version(runtime.pythonPackages?.[distribution])
              : undefined,
            bundleVersion: fallback,
          };
        }
      } catch {
        // Standard MCPB uploads need not include this optional runtime metadata.
      }
      return { bundleVersion: fallback };
    } catch {
      // Ordinary Node servers need not be MCPB installations.
    }
  }
}

export async function resolveMcpbPackageVersion(config?: {
  command?: string;
  args?: string[];
}): Promise<string | undefined> {
  return (await resolveMcpbVersions(config))?.packageVersion;
}
