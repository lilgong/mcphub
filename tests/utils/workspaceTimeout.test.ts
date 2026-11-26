import { workspaceUpstreamTimeout } from '../../src/utils/workspaceTimeout.js';

test('caller execution budget is separate from queue time and respects operator ceilings', () => {
  expect(workspaceUpstreamTimeout('7000', 0)).toBe(7000);
  expect(workspaceUpstreamTimeout('7000', 5000)).toBe(5000);
  expect(workspaceUpstreamTimeout(undefined, 10000)).toBe(10000);
  expect(workspaceUpstreamTimeout(undefined, 0)).toBe(300000);
});

test.each(['0', '-1', 'Infinity', 'NaN', '1e3', '0.5', '2147483648', '3,4'])(
  'rejects invalid budget %s',
  (header) => {
    expect(() => workspaceUpstreamTimeout(header)).toThrow();
  },
);
