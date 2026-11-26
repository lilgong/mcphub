const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar dates are presentation boundaries; persisted timestamps stay UTC. */
export function calendarDate(timestamp: string | number, timeZone = 'UTC'): string {
  if (timeZone === 'UTC') return new Date(timestamp).toISOString().slice(0, 10);
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(timestamp));
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function wholeCalendarDays(start: Date, end: Date, timeZone = 'UTC'): boolean {
  const midnight = (date: Date) => {
    if (date.getUTCMilliseconds() !== 0) return false;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    return parts
      .filter((part) => ['hour', 'minute', 'second'].includes(part.type))
      .every((part) => part.value === '00');
  };
  return midnight(start) && midnight(new Date(+end + 1));
}
