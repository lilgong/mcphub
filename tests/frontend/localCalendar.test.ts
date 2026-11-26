import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync('frontend/src/utils/localCalendar.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const run = (zone: string, expression: string) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['-e', `${compiled}\nconsole.log(JSON.stringify(${expression}));`],
      { env: { ...process.env, TZ: zone }, encoding: 'utf8' },
    ),
  );

test('browser day and month selection use local dates, not UTC dates', () => {
  expect(run('Asia/Shanghai', "exports.localCalendarDate(new Date('2026-11-22T16:00:00Z'))")).toBe(
    '2026-11-23',
  );
  expect(run('Asia/Shanghai', "exports.localDateRange('2026-11-22')")).toEqual({
    start: '2026-11-21T16:00:00.000Z',
    end: '2026-11-22T15:59:59.999Z',
  });
  expect(run('Asia/Shanghai', "exports.localMonthEnd('2028-02')")).toBe('2028-02-29');
});

test.each([
  ['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z'],
  ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z'],
])('DST uses actual midnight boundaries for %s', (day, start, end) => {
  expect(run('America/New_York', `exports.localDateRange('${day}')`)).toEqual({ start, end });
});
