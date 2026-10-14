import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiGet } from '../utils/fetchInterceptor';
import SecretInput from './SecretInput';
import { credentialFingerprint } from '../utils/credentialFingerprint';
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
  unavailableSources?: string[];
}
export default function CallStatistics() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [start, setStart] = useState(month + '-01');
  const [end, setEnd] = useState(new Date().toISOString().slice(0, 10));
  const [server, setServer] = useState('');
  const [metric, setMetric] = useState('tool');
  const [key, setKey] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [data, setData] = useState<Result>();
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({
      server,
      metric,
      ...(metric === 'upstream' && fingerprint ? { credentialId: fingerprint } : {}),
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
  }, [server, start, end, refresh, metric, fingerprint]);
  const input = 'hub-input';
  return (
    <section className="space-y-5">
      <p className="hub-sub">
        {t(metric === 'upstream' ? 'statistics.upstreamDescription' : 'statistics.description')}
      </p>
      <div className="hub-card flex flex-wrap items-end gap-3 p-4">
        <label className="hub-field">
          <span className="hub-label">{t('statistics.metric')}</span>
          <select
            className="hub-input"
            value={metric}
            onChange={(e) => {
              setMetric(e.target.value);
              setData(undefined);
            }}
          >
            <option value="tool">{t('statistics.toolCalls')}</option>
            <option value="upstream">{t('statistics.upstreamCalls')}</option>
          </select>
        </label>
        <label className="hub-field">
          <span className="hub-label">{t('statistics.month')}</span>
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
        <label className="hub-field">
          <span className="hub-label">{t('statistics.start')}</span>
          <input
            aria-label={t('statistics.start')}
            className={`${input} block`}
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="hub-field">
          <span className="hub-label">{t('statistics.end')}</span>
          <input
            aria-label={t('statistics.end')}
            className={`${input} block`}
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label className="hub-field">
          <span className="hub-label">{t('statistics.server')}</span>
          <input
            aria-label={t('statistics.server')}
            className={`${input} block w-40`}
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
        </label>
        <button className="hub-btn" onClick={() => setRefresh((n) => n + 1)}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t('callLogs.refresh')}
        </button>
      </div>
      {metric === 'upstream' && (
        <div className="hub-card space-y-3 p-4">
          <label className="hub-field">
            <span className="hub-label">{t('statistics.upstreamKey')}</span>
            <div className="flex flex-wrap items-center gap-3">
              <SecretInput
                className="hub-input min-w-0 flex-1"
                sensitive
                secretLabel={t('statistics.upstreamKey')}
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button
                type="button"
                className="hub-btn"
                onClick={() => {
                  setFingerprint(key.trim() ? credentialFingerprint(key) : '');
                  setKey('');
                  setData(undefined);
                }}
              >
                {t('statistics.applyKey')}
              </button>
              {fingerprint && (
                <button
                  type="button"
                  className="hub-btn"
                  onClick={() => {
                    setFingerprint('');
                    setKey('');
                    setData(undefined);
                  }}
                >
                  {t('statistics.clearKey')}
                </button>
              )}
            </div>
          </label>
          <p className="hub-sub text-xs">
            {t('statistics.keyPrivacy')}
            {fingerprint && <> · {fingerprint}</>}
          </p>
        </div>
      )}
      {metric === 'upstream' && <p className="hub-sub text-sm">{t('statistics.coverage')}</p>}
      {!!data?.unavailableSources?.length && <p role="alert">{t('statistics.incomplete')}</p>}
      {error && <p role="alert">{t('callLogs.failed')}</p>}
      {data?.available === false && <p>{t('statistics.unavailable')}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
                <th className="bg-[var(--hub-bg)] p-4 text-xs font-medium hub-sub" key={field}>
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
