import { relayDisplay } from '../../frontend/src/utils/relayDisplay';
const connection = { type: 'stdio' as const, env: { MCPHUB_RELAY_ADAPTER: 'fetch-v1' } };
test('configured forwarding differs from relay readiness and explicit opt-out', () => {
  expect(relayDisplay(connection, true)).toBe('enabled');
  expect(relayDisplay(connection, false)).toBe('unavailable');
  expect(relayDisplay({ ...connection, relay: { enabled: false } }, true)).toBeUndefined();
  expect(relayDisplay({ type: 'stdio', command: 'native' }, true)).toBeUndefined();
});
test('task forwarding is deferred until task startup and disabled targets are excluded', () => {
  const task = { path: 'task/default', kind: 'task' as const, config: connection };
  expect(relayDisplay({ targets: [task] }, true)).toBe('task');
  expect(relayDisplay({ targets: [{ ...task, enabled: false }] }, true)).toBeUndefined();
});
