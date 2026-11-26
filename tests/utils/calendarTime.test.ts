import { calendarDate, wholeCalendarDays } from '../../src/utils/calendarTime.js';

test('local day boundaries differ from UTC, including month and year changes', () => {
  expect(calendarDate('2026-12-31T16:00:00Z', 'Asia/Shanghai')).toBe('2027-01-01');
  expect(calendarDate('2026-11-22T23:00:00Z', 'America/Los_Angeles')).toBe('2026-11-22');
  expect(calendarDate('2026-11-22T16:00:00Z', 'Asia/Shanghai')).toBe('2026-11-23');
});

test.each([
  ['Asia/Shanghai', '2026-11-21T16:00:00Z', '2026-11-22T15:59:59.999Z'],
  ['America/New_York', '2026-03-08T05:00:00Z', '2026-03-09T03:59:59.999Z'],
  ['America/New_York', '2026-11-01T04:00:00Z', '2026-11-02T04:59:59.999Z'],
  ['Asia/Kathmandu', '2026-11-21T18:15:00Z', '2026-11-22T18:14:59.999Z'],
])('recognizes full local days including DST and fractional offsets: %s', (zone, start, end) => {
  expect(wholeCalendarDays(new Date(start), new Date(end), zone)).toBe(true);
  expect(wholeCalendarDays(new Date(+new Date(start) + 60000), new Date(end), zone)).toBe(false);
});
