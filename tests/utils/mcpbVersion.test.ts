import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMcpbPackageVersion } from '../../src/utils/mcpbVersion.js';

describe('installed MCPB versions', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mcphub-version-'));
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        manifest_version: '0.3',
        version: '0.1.0+delivery',
        server: { entry_point: 'launch.cjs' },
      }),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const config = (root: string) => ({ command: 'node', args: [join(root, 'launch.cjs')] });
  it('reads a pinned Node package version instead of the delivery revision', async () => {
    await writeFile(
      join(root, 'runtime.json'),
      JSON.stringify({ kind: 'node', source: '@vendor/mcp@2.3.4' }),
    );
    await mkdir(join(root, 'server/node_modules/@vendor/mcp'), { recursive: true });
    await writeFile(
      join(root, 'server/node_modules/@vendor/mcp/package.json'),
      JSON.stringify({ version: '2.3.4' }),
    );
    expect(await resolveMcpbPackageVersion(config(root))).toBe('2.3.4');
  });
  it('reads the entrypoint distribution rather than the Python SDK version', async () => {
    await writeFile(
      join(root, 'runtime.json'),
      JSON.stringify({
        kind: 'python',
        entrypoint: 'venv/bin/mcp-server-fetch',
        pythonPackages: { 'mcp-server-fetch': '2025.4.7', mcp: '1.28.1' },
      }),
    );
    expect(await resolveMcpbPackageVersion(config(root))).toBe('2025.4.7');
  });
  it('falls back to the standard bundle manifest when runtime metadata is absent or invalid', async () => {
    expect(await resolveMcpbPackageVersion(config(root))).toBe('0.1.0+delivery');
    await writeFile(join(root, 'runtime.json'), 'invalid json');
    expect(await resolveMcpbPackageVersion(config(root))).toBe('0.1.0+delivery');
  });
  it('ignores manifests belonging to another entrypoint and ordinary runners', async () => {
    expect(
      await resolveMcpbPackageVersion({ command: 'node', args: [join(root, 'other.cjs')] }),
    ).toBeUndefined();
    expect(
      await resolveMcpbPackageVersion({ command: 'npx', args: ['some-package'] }),
    ).toBeUndefined();
  });
  it('does not follow a runtime package path outside the bundle', async () => {
    await writeFile(
      join(root, 'runtime.json'),
      JSON.stringify({ kind: 'node', source: '../../other@1.0.0' }),
    );
    expect(await resolveMcpbPackageVersion(config(root))).toBe('0.1.0+delivery');
  });
});
