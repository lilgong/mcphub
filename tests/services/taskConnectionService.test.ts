import {
  TaskConnectionRegistry,
  watchTaskRequest,
} from '../../src/services/taskConnectionService.js';
import { normalizeTargetConnections } from '../../src/utils/targetConnection.js';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const create = () =>
  new TaskConnectionRegistry().register({
    server: 'toolathlon::word',
    target: 'task/default',
    taskId: 'run-a',
    owner: 'key-a',
    username: 'operator',
    url: 'http://worker',
    upstreamToken: 'secret',
  });
test('Atlas retains the default 150-second request budget', () => {
  const abort = new AbortController();
  const stop = watchTaskRequest(create(), abort);
  jest.advanceTimersByTime(149999);
  expect(abort.signal.aborted).toBe(false);
  jest.advanceTimersByTime(1);
  expect(abort.signal.aborted).toBe(true);
  stop();
});
test('unlimited extra budget follows renewed leases and still aborts at expiry', () => {
  const entry = create();
  const abort = new AbortController();
  const stop = watchTaskRequest(entry, abort, 0);
  jest.advanceTimersByTime(240000);
  entry.expiresAt = Date.now() + 300000;
  jest.advanceTimersByTime(60000);
  expect(abort.signal.aborted).toBe(false);
  jest.advanceTimersByTime(240000);
  expect(abort.signal.aborted).toBe(true);
  stop();
});
test('renewals never extend an explicit request budget; cleanup removes watches', () => {
  const entry = create();
  const abort = new AbortController();
  const stop = watchTaskRequest(entry, abort, 1000);
  entry.expiresAt += 300000;
  jest.advanceTimersByTime(1000);
  expect(abort.signal.aborted).toBe(true);
  stop();
  expect(jest.getTimerCount()).toBe(0);
});
test('zero disables only extra budget and is persisted; invalid budgets are rejected', () => {
  const target = { path: 'task/default', kind: 'task', config: { options: { timeout: 0 } } };
  expect(normalizeTargetConnections([target])?.[0].config?.options?.timeout).toBe(0);
  for (const timeout of [-1, 1.5, '1000', 2147483648]) {
    expect(() =>
      normalizeTargetConnections([{ ...target, config: { options: { timeout } } }]),
    ).toThrow();
  }
});
