import { DEFAULT_TASK_TARGET, resolveTaskTarget } from '../../src/utils/taskTarget.js';

test('only a dedicated default task target can omit the selector', () => {
  const task = { path: DEFAULT_TASK_TARGET, kind: 'task' as const };
  expect(resolveTaskTarget([task])).toBe(task);
  expect(resolveTaskTarget([{ ...task, path: 'atlas/official' }])).toBeUndefined();
  expect(resolveTaskTarget([task, { ...task, path: 'atlas/fixture' }])).toBeUndefined();
  expect(resolveTaskTarget([{ ...task, kind: 'static' }])).toBeUndefined();
  expect(resolveTaskTarget([task], 'atlas/fixture')).toBeUndefined();
});
