import {
  browserTimeZone,
  localCalendarDate,
  localDateRange,
  localMonthEnd,
} from '../utils/localCalendar';
import LogCatalogFilter from './LogCatalogFilter';
import LogServerIdentity from './LogServerIdentity';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiGet } from '../utils/fetchInterceptor';
import SecretInput from './SecretInput';
import { credentialFingerprint } from '../utils/credentialFingerprint';
interface Row {
  catalog?: string;
  server: string;
  calls: number;
  success: number;
  errors: number;
  durationMs: number;
  credentialId?: string;
  credentialSuffix?: string;
}
interface Result {
  rows: Row[];
  keyRows?: Row[];
  total: number;
  success: number;
  errors: number;
  available: boolean;
  unavailableSources?: string[];
}
export default function CallStatistics() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(localCalendarDate().slice(0, 7));
  const [start, setStart] = useState(month + '-01');
  const [end, setEnd] = useState(localCalendarDate());
  const [server, setServer] = useState('');
  const [catalog, setCatalog] = useState('*');
  const [metric, setMetric] = useState('yibu');
  const [key, setKey] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [data, setData] = useState<Result>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!start || !end || end < start) {
      setLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setData(undefined);
    setError(false);
    const query = new URLSearchParams({
      server,
      ...(catalog !== '*' ? { catalog } : {}),
      metric,
      ...(metric !== 'tool' && fingerprint ? { credentialId: fingerprint } : {}),
      ...localDateRange(start, end),
      timeZone: browserTimeZone(),
    });
    const timer = window.setTimeout(() => {
      void apiGet<{ success: boolean; data: Result }>(`/logs/statistics?${query}`, {
        signal: controller.signal,
      })
        .then((result) => {
          if (active) {
            setError(!result.success);
            if (result.success) setData(result.data);
          }
        })
        .catch(() => {
          if (active) setError(true);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 350);
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [catalog, server, start, end, refresh, metric, fingerprint]);
  const rows = metric !== 'tool' ? (data?.keyRows ?? data?.rows) : data?.rows;
  const input = 'hub-input';
  return (
    <section className="space-y-5">
      <p className="hub-sub">
        {t(
          metric === 'yibu'
            ? 'statistics.yibuDescription'
            : metric === 'upstream'
              ? 'statistics.upstreamDescription'
              : 'statistics.description',
        )}
      </p>
      <div className="hub-card flex flex-wrap items-end gap-3 p-4">
        <LogCatalogFilter value={catalog} onChange={setCatalog} refresh={refresh} />
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
            <option value="yibu">{t('statistics.yibuCalls')}</option>
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
              setEnd(localMonthEnd(e.target.value));
            }}
          />
        </label>
        <label className="hub-field">
          <span className="hub-label">
            {t('statistics.start', { timeZone: browserTimeZone() })}
          </span>
          <input
            aria-label={t('statistics.start', { timeZone: browserTimeZone() })}
            className={`${input} block`}
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="hub-field">
          <span className="hub-label">{t('statistics.end', { timeZone: browserTimeZone() })}</span>
          <input
            aria-label={t('statistics.end', { timeZone: browserTimeZone() })}
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
            placeholder={t('statistics.serverPlaceholder')}
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
      {metric !== 'tool' && (
        <div className="hub-card space-y-3 p-4">
          <label className="hub-field">
            <span className="hub-label">{t('statistics.upstreamKey')}</span>
            <div className="flex flex-wrap items-center gap-3">
              <SecretInput
                className="hub-input min-w-0 flex-1"
                sensitive
                secretLabel={t('statistics.upstreamKey')}
                aria-label={t('statistics.upstreamKey')}
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
      {loading && (
        <p role="status" className="hub-sub">
          {t('statistics.loading')}
        </p>
      )}
      {error && <p role="alert">{t('callLogs.failed')}</p>}
      {data?.available === false && <p>{t('statistics.unavailable')}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {(['total', 'success', 'errors'] as const).map((field) => (
          <div className="hub-card p-5" key={field}>
            <p className="hub-sub">{t(`statistics.${field}`)}</p>
            <p className="mt-2 text-3xl font-semibold hub-num">
              {loading ? '—' : (data?.[field] ?? 0)}
            </p>
          </div>
        ))}
      </div>
      <div className="hub-card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {(metric !== 'tool'
                ? ['server', 'credential', 'total', 'success', 'errors']
                : ['server', 'total', 'success', 'errors']
              ).map((field) => (
                <th className="bg-[var(--hub-bg)] p-4 text-xs font-medium hub-sub" key={field}>
                  {t(`statistics.${field}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows?.map((row, i) => (
              <tr className="border-t border-[var(--hub-line)]" key={i}>
                <td className="p-4 font-medium">
                  <LogServerIdentity
                    server={row.server}
                    catalog={row.catalog}
                    showCatalog={catalog === '*'}
                  />
                </td>
                {metric !== 'tool' && (
                  <td className="p-4">
                    <span className="font-mono">
                      {row.credentialSuffix
                        ? `…${row.credentialSuffix}`
                        : row.credentialId || t('statistics.unknownKey')}
                    </span>
                    {row.credentialSuffix && row.credentialId && (
                      <span className="hub-sub mt-1 block text-xs font-mono">
                        {row.credentialId}
                      </span>
                    )}
                  </td>
                )}
                <td className="p-4 hub-num">{row.calls}</td>
                <td className="p-4 hub-num">{row.success}</td>
                <td className="p-4 hub-num">{row.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows?.length === 0 && <p className="p-5 hub-sub">{t('callLogs.empty')}</p>}
      </div>
    </section>
  );
}
