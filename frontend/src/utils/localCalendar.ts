export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function localCalendarDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Construct each midnight separately so DST days retain their actual length. */
export function localDateRange(start: string, end = start): { start: string; end: string } {
  const [year, month, day] = end.split('-').map(Number);
  return {
    start: new Date(`${start}T00:00:00`).toISOString(),
    end: new Date(new Date(year, month - 1, day + 1).getTime() - 1).toISOString(),
  };
}

export function localMonthEnd(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return localCalendarDate(new Date(year, number, 0));
}
