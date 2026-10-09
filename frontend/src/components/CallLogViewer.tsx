import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiGet } from '../utils/fetchInterceptor';
interface Row {
  id: string;
  timestamp: string;
  source: string;
  server: string;
  operation: string;
  outcome: string;
  httpStatus?: number;
  category?: string;
  durationMs?: number;
  waitMs?: number;
  keyLabel?: string;
  retryAt?: string;
}
interface Result {
  rows: Row[];
  total: number;
  truncated: boolean;
  unavailableSources: string[];
}
export default function CallLogViewer() {
  const { t } = useTranslation();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('all');
  const [server, setServer] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(true);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<Result>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setPage(1);
  }, [date, status, source, server, errorsOnly]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const query = new URLSearchParams({
          date,
          status,
          source,
          server,
          errorsOnly: String(errorsOnly),
          page: String(page),
          limit: '50',
        });
        const result = await apiGet<{ success: boolean; data: Result }>(`/logs/calls?${query}`);
        if (!result.success) throw new Error();
        if (active) {
          setData(result.data);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [date, status, source, server, errorsOnly, page, refresh]);
  const inputClass = 'hub-input rounded border p-2';
  return (
    <section className="space-y-4 p-4">
      <p className="text-sm text-[var(--hub-ink-2)]">{t('callLogs.description')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label>
          {t('callLogs.date')}
          <input
            aria-label={t('callLogs.date')}
            type="date"
            className={`${inputClass} block`}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          {t('callLogs.status')}
          <select
            aria-label={t('callLogs.status')}
            className={`${inputClass} block`}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              if (e.target.value === '200') setErrorsOnly(false);
            }}
          >
            {[
              'all',
              '429',
              '4xx',
              '5xx',
              '400',
              '401',
              '403',
              '404',
              '408',
              '500',
              '502',
              '503',
              '504',
              '200',
              'none',
            ].map((value) => (
              <option key={value} value={value}>
                {value === 'all' || value === 'none' ? t(`callLogs.${value}`) : value}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('callLogs.source')}
          <select
            aria-label={t('callLogs.source')}
            className={`${inputClass} block`}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            {['all', 'tool', 'yibu', 'relay', 'key_pool'].map((value) => (
              <option key={value} value={value}>
                {t(`callLogs.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('callLogs.server')}
          <input
            aria-label={t('callLogs.server')}
            className={`${inputClass} block`}
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
        </label>
        <label className="p-2">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
          />{' '}
          {t('callLogs.errorsOnly')}
        </label>
        <button
          className="rounded border p-2"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t('callLogs.refresh')}
        </button>
      </div>
      {error && <p role="alert">{t('callLogs.failed')}</p>}
      {data?.truncated && <p>{t('callLogs.truncated')}</p>}
      {!!data?.unavailableSources.length && (
        <p>
          {t('callLogs.unavailable')}:{' '}
          {data.unavailableSources.map((value) => t(`callLogs.${value}`)).join(', ')}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {[
                'time',
                'source',
                'server',
                'operation',
                'status',
                'category',
                'keyLabel',
                'retryAt',
                'wait',
                'duration',
              ].map((key) => (
                <th className="p-2" key={key}>
                  {t(`callLogs.${key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((row, index) => (
              <tr className="border-t" key={`${row.source}-${row.id}-${index}`} title={row.id}>
                <td className="whitespace-nowrap p-2">
                  {new Date(row.timestamp).toLocaleString()}
                </td>
                <td className="p-2">{t(`callLogs.${row.source}`)}</td>
                <td className="p-2">{row.server}</td>
                <td className="max-w-xs break-all p-2">{row.operation}</td>
                <td className={`p-2 ${row.outcome === 'error' ? 'text-red-600' : ''}`}>
                  {row.httpStatus ?? t(`callLogs.${row.outcome}`)}
                </td>
                <td className="p-2">{row.category || '—'}</td>
                <td className="p-2">{row.keyLabel || '—'}</td>
                <td className="whitespace-nowrap p-2">
                  {row.retryAt ? new Date(row.retryAt).toLocaleString() : '—'}
                </td>
                <td className="p-2">
                  {row.waitMs === undefined ? '—' : `${Math.round(row.waitMs)} ms`}
                </td>
                <td className="p-2">
                  {row.durationMs === undefined ? '—' : `${Math.round(row.durationMs)} ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data?.rows.length === 0 && <p>{t('callLogs.empty')}</p>}
      <div className="flex items-center gap-3">
        <button
          className="rounded border p-2"
          disabled={page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          ←
        </button>
        <span>
          {page} / {Math.max(1, Math.ceil((data?.total || 0) / 50))} · {data?.total || 0}
        </span>
        <button
          className="rounded border p-2"
          disabled={!data || page * 50 >= data.total}
          onClick={() => setPage((value) => value + 1)}
        >
          →
        </button>
      </div>
    </section>
  );
}
