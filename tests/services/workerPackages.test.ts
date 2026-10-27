import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { prepareWorkerPackage } from '../../src/workers/workerPackages.js';
const original = process.env;
test('immutable releases isolate uploads and rewrite executable/Python paths without changing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-packages-'));
  process.env = {
    ...original,
    MCPHUB_WORKER_PACKAGES: join(root, 'uploads'),
    MCPHUB_WORKER_RELEASES: join(root, 'releases'),
  };
  try {
    const source = join(root, 'uploads/server-atlas~fetch');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: '1' }));
    await writeFile(join(source, '.mcphub-install-id'), 'first-upload');
    await writeFile(join(source, 'launch.cjs'), 'original');
    const configured = '/app/data/uploads/mcpb/catalogs/atlas/server-atlas~fetch';
    const launch = {
      name: 'atlas::fetch',
      command: 'node',
      args: [configured + '/launch.cjs'],
      env: { PYTHONPATH: configured + '/venv', API_KEY: 'provider-secret' },
      maxBufferSize: 1024,
    };
    const [first, same] = await Promise.all([
      prepareWorkerPackage(launch, 'atlas'),
      prepareWorkerPackage(launch, 'atlas'),
    ]);
    expect(first.args).toEqual(same.args);
    expect(first.env.API_KEY).toBe('provider-secret');
    expect(first.env.PYTHONPATH).toBe(dirname(first.args[0]) + '/venv');
    await writeFile(join(source, '.mcphub-install-id'), 'second-upload');
    await writeFile(join(source, 'launch.cjs'), 'new-version');
    const next = await prepareWorkerPackage(launch, 'atlas');
    expect(next.args).not.toEqual(first.args);
    expect(await readFile(first.args[0], 'utf8')).toBe('original');
    expect(await readFile(next.args[0], 'utf8')).toBe('new-version');
    expect(await readFile(join(source, 'launch.cjs'), 'utf8')).toBe('new-version');
  } finally {
    process.env = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('a bundled command is relocated even when args contain no package path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-command-'));
  process.env = {
    ...original,
    MCPHUB_WORKER_PACKAGES: join(root, 'uploads'),
    MCPHUB_WORKER_RELEASES: join(root, 'releases'),
  };
  try {
    const source = join(root, 'uploads/server-atlas~shell');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: '1' }));
    await writeFile(join(source, 'server.sh'), '#!/bin/sh\necho ready\n', { mode: 0o755 });
    const configured = '/app/data/uploads/mcpb/catalogs/atlas/server-atlas~shell';
    const result = await prepareWorkerPackage(
      {
        name: 'atlas::shell',
        command: configured + '/server.sh',
        args: [],
        env: { DATA: configured + '/data' },
        maxBufferSize: 1024,
      },
      'atlas',
    );
    expect(result.command).not.toBe(configured + '/server.sh');
    expect(await readFile(result.command, 'utf8')).toContain('echo ready');
    expect(result.env.DATA).toBe(dirname(result.command) + '/data');
  } finally {
    process.env = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('an exact package-root PYTHONPATH triggers snapshotting for python -m', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-module-root-'));
  process.env = {
    ...original,
    MCPHUB_WORKER_PACKAGES: join(root, 'uploads'),
    MCPHUB_WORKER_RELEASES: join(root, 'releases'),
  };
  try {
    const source = join(root, 'uploads/server-atlas~module');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ version: '1' }));
    await writeFile(join(source, 'server.py'), 'print("module loaded")\n');
    const configured = '/app/data/uploads/mcpb/catalogs/atlas/server-atlas~module';
    const result = await prepareWorkerPackage(
      {
        name: 'atlas::module',
        command: 'python3',
        args: ['-m', 'server'],
        env: { PYTHONPATH: configured, UNRELATED: configured + '-backup' },
        maxBufferSize: 1024,
      },
      'atlas',
    );
    expect(result.env.PYTHONPATH).not.toBe(configured);
    expect(await readFile(join(result.env.PYTHONPATH, 'server.py'), 'utf8')).toContain(
      'module loaded',
    );
    expect(result.env.UNRELATED).toBe(configured + '-backup');
    expect(result.command).toBe('python3');
    expect(result.args).toEqual(['-m', 'server']);
    expect(
      execFileSync(result.command, result.args, {
        env: { ...process.env, ...result.env },
        encoding: 'utf8',
      }).trim(),
    ).toBe('module loaded');
  } finally {
    process.env = original;
    await rm(root, { recursive: true, force: true });
  }
});
