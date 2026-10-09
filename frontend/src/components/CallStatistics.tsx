import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiGet } from '../utils/fetchInterceptor';
interface Row {
  server: string;
  calls: number;
  success: number;
  errors: number;
  durationMs: number;
}
interface Result {
  rows: Row[];
  total: number;
  success: number;
  errors: number;
  available: boolean;
}
export default function CallStatistics() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [start, setStart] = useState(month + '-01');
  const [end, setEnd] = useState(new Date().toISOString().slice(0, 10));
  const [server, setServer] = useState('');
  const [data, setData] = useState<Result>();
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({
      server,
      start: start + 'T00:00:00Z',
      end: end + 'T23:59:59.999Z',
    });
    void apiGet<{ success: boolean; data: Result }>(`/logs/statistics?${query}`)
      .then((result) => {
        if (active) {
          setError(!result.success);
          if (result.success) setData(result.data);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [server, start, end, refresh]);
  const input = 'hub-input rounded border p-2';
  return (
    <section className="space-y-5">
      <p className="hub-sub">{t('statistics.description')}</p>
      <div className="hub-card flex flex-wrap items-end gap-3 p-4">
        <label>
          {t('statistics.month')}
          <input
            className={`${input} block`}
            type="month"
            value={month}
            onChange={(e) => {
              if (!e.target.value) return;
              setMonth(e.target.value);
              setStart(e.target.value + '-01');
              const date = new Date(e.target.value + '-01T00:00:00Z');
              date.setUTCMonth(date.getUTCMonth() + 1);
              date.setUTCDate(0);
              setEnd(date.toISOString().slice(0, 10));
            }}
          />
        </label>
        <label>
          {t('statistics.start')}
          <input
            aria-label={t('statistics.start')}
            className={`${input} block`}
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          {t('statistics.end')}
          <input
            aria-label={t('statistics.end')}
            className={`${input} block`}
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label>
          {t('statistics.server')}
          <input
            aria-label={t('statistics.server')}
            className={`${input} block w-40`}
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
        </label>
        <button className="hub-btn" onClick={() => setRefresh((n) => n + 1)}>
          {t('callLogs.refresh')}
        </button>
      </div>
      {error && <p role="alert">{t('callLogs.failed')}</p>}
      {data?.available === false && <p>{t('statistics.unavailable')}</p>}
      <div className="grid grid-cols-3 gap-4">
        {(['total', 'success', 'errors'] as const).map((field) => (
          <div className="hub-card p-5" key={field}>
            <p className="hub-sub">{t(`statistics.${field}`)}</p>
            <p className="mt-2 text-3xl font-semibold hub-num">{data?.[field] ?? 0}</p>
          </div>
        ))}
      </div>
      <div className="hub-card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {['server', 'total', 'success', 'errors'].map((field) => (
                <th className="p-4" key={field}>
                  {t(`statistics.${field}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((row, i) => (
              <tr className="border-t border-[var(--hub-line)]" key={i}>
                <td className="p-4 font-medium">{row.server}</td>
                <td className="p-4 hub-num">{row.calls}</td>
                <td className="p-4 hub-num">{row.success}</td>
                <td className="p-4 hub-num">{row.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.rows.length === 0 && <p className="p-5 hub-sub">{t('callLogs.empty')}</p>}
      </div>
    </section>
  );
}
