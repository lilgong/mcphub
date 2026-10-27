import {
  filterGroupResources,
  selectVisibleGroupResources,
} from '../../frontend/src/utils/groupResourceSelection';
import type { UserGroupResourceOption } from '../../src/types/userGroup';

const servers: UserGroupResourceOption[] = [
  {
    name: 'atlas::notion',
    enabled: true,
    targets: [
      { path: 'official', kind: 'static', enabled: true },
      { path: 'fixture3', kind: 'static', enabled: true },
    ],
  },
  {
    name: 'toolathlon::notion',
    enabled: true,
    targets: [{ path: 'task/default', kind: 'task', enabled: true }],
  },
  { name: 'toolathlon::fetch', enabled: true, targets: [] },
  { name: 'serper', enabled: true, targets: [] },
];
test('searching toolathlon then selecting all never grants Atlas or public resources', () => {
  const visible = filterGroupResources(servers, '*', ' Toolathlon ');
  expect(selectVisibleGroupResources([], visible, true)).toEqual([
    { name: 'toolathlon::notion', targets: ['task/default'] },
    { name: 'toolathlon::fetch' },
  ]);
});
test('space and search intersect; public is separate from all spaces', () => {
  expect(
    filterGroupResources(servers, 'toolathlon', 'notion').map((server) => server.name),
  ).toEqual(['toolathlon::notion']);
  expect(filterGroupResources(servers, '', '').map((server) => server.name)).toEqual(['serper']);
  expect(filterGroupResources(servers, 'atlas', 'toolathlon')).toEqual([]);
});
test('filtered select and clear preserve hidden permissions and partial target grants', () => {
  const existing = [{ name: 'atlas::notion', targets: ['official'] }, { name: 'serper' }];
  const visible = filterGroupResources(servers, 'toolathlon', '');
  const selected = selectVisibleGroupResources(existing, visible, true);
  expect(selected).toEqual([
    ...existing,
    { name: 'toolathlon::notion', targets: ['task/default'] },
    { name: 'toolathlon::fetch' },
  ]);
  expect(selectVisibleGroupResources(selected, visible, false)).toEqual(existing);
  expect(selectVisibleGroupResources(existing, [], true)).toEqual(existing);
  expect(existing[0].targets).toEqual(['official']);
});
