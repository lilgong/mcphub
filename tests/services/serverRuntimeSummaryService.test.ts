import { summarizeServerRuntime } from '../../src/services/serverRuntimeSummaryService.js';
import { TaskConnectionRegistry } from '../../src/services/taskConnectionService.js';

test('configured targets are not running instances, and starting clients count separately', () => {
  const targets = [
    { path: 'suite/a', kind: 'static' as const, implementation: 'wrapper' as const, version: 'v1' },
  ];
  expect(summarizeServerRuntime(targets, [])).toMatchObject({
    running: 0,
    starting: 0,
    targets: [{ running: 0, starting: 0 }],
  });
  expect(
    summarizeServerRuntime(targets, [
      { id: 'a', kind: 'target', target: 'suite/a', status: 'connected' },
      { id: 'b', kind: 'target', target: 'suite/a', status: 'connecting' },
      { id: 'c', kind: 'shared', status: 'disconnected' },
    ]),
  ).toMatchObject({
    running: 1,
    starting: 1,
    targets: [{ running: 1, starting: 1, implementation: 'wrapper', configuredVersion: 'v1' }],
  });
});

test('task inventory contains metadata only, expires, and excludes disabled target registrations from active counts', () => {
  const registry = new TaskConnectionRegistry();
  const entry = registry.register({
    server: 'memory',
    target: 'other/task',
    taskId: 'task-a',
    owner: 'operator',
    username: 'admin',
    url: 'http://secret-host',
    upstreamToken: 'upstream-secret',
    configuredVersion: 'image:v1',
    implementation: 'custom',
  });
  const snapshot = registry.snapshot('memory');
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0]).toMatchObject({
    status: 'registered',
    configuredVersion: 'image:v1',
    taskId: 'task-a',
  });
  const serialized = JSON.stringify(snapshot);
  for (const secret of [entry.token, 'upstream-secret', 'secret-host'])
    expect(serialized).not.toContain(secret);
  const targets = [{ path: 'other/task', kind: 'task' as const }];
  expect(summarizeServerRuntime(targets, snapshot).running).toBe(1);
  expect(summarizeServerRuntime([{ ...targets[0], enabled: false }], snapshot).running).toBe(0);
  expect(summarizeServerRuntime([], snapshot).running).toBe(0);
  expect(summarizeServerRuntime(targets, snapshot, false).running).toBe(0);
  entry.expiresAt = Date.now() - 1;
  expect(registry.snapshot('memory')).toEqual([]);
});
