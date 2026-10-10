import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, FileSearch, RefreshCw } from 'lucide-react';
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
  target?: string;
  taskId?: string;
}
interface Result {
  rows: Row[];
  total: number;
  truncated: boolean;
  unavailableSources: string[];
}

function statusBadgeClass(row: Row): string {
  if (row.httpStatus === 429) {
    return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300';
  }
  if (row.outcome === 'error' || (row.httpStatus !== undefined && row.httpStatus >= 400)) {
    return 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300';
  }
  if (row.outcome === 'success' || (row.httpStatus !== undefined && row.httpStatus < 300)) {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300';
  }
  return 'border-[var(--hub-line)] bg-[var(--hub-bg)] text-[var(--hub-ink-2)]';
}

export default function CallLogViewer() {
  const { t } = useTranslation();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('tool');
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
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium hub-sub">{t('callLogs.date')}</span>
          <input
            aria-label={t('callLogs.date')}
            type="date"
            className={`${inputClass} block`}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium hub-sub">{t('callLogs.status')}</span>
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
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium hub-sub">{t('callLogs.source')}</span>
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
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium hub-sub">{t('callLogs.server')}</span>
          <input
            aria-label={t('callLogs.server')}
            className={`${inputClass} block`}
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
        </label>
        <label className="flex h-[30px] items-center gap-2 px-1 text-sm hub-sub">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
          />
          {t('callLogs.errorsOnly')}
        </label>
        <button
          className="hub-btn"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
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
      <div className="overflow-hidden rounded-xl border border-[var(--hub-line)]">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {['time', 'server', 'operation', 'status', 'duration', 'details'].map((key) => (
                  <th className="bg-[var(--hub-bg)] p-3 text-xs font-medium hub-sub" key={key}>
                    {t(`callLogs.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.rows.length === 0 && !error && (
                <tr>
                  <td colSpan={6} className="px-6 py-14 text-center">
                    <div
                      className="mx-auto flex max-w-sm flex-col items-center gap-3"
                      role="status"
                    >
                      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--hub-bg)] hub-sub">
                        <FileSearch className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <div className="space-y-2">
                        <p className="text-sm font-medium">{t('callLogs.empty')}</p>
                        <p className="text-xs leading-5 hub-sub">
                          {t(errorsOnly ? 'callLogs.emptyErrorsHint' : 'callLogs.emptyHint')}
                        </p>
                      </div>
                      {errorsOnly && (
                        <button className="hub-btn sm mt-1" onClick={() => setErrorsOnly(false)}>
                          {t('callLogs.showAllCalls')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              {data?.rows.map((row, index) => (
                <tr
                  className="border-t border-[var(--hub-line)] hover:bg-[var(--hub-bg)]"
                  key={`${row.source}-${row.id}-${index}`}
                  title={row.id}
                >
                  <td className="whitespace-nowrap p-2">
                    {new Date(row.timestamp).toLocaleString()}
                  </td>
                  <td className="p-2">{row.server}</td>
                  <td className="max-w-xs break-all p-2">{row.operation}</td>
                  <td className="whitespace-nowrap p-3">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(row)}`}
                    >
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                      <span
                        className={
                          row.httpStatus === undefined ? undefined : 'font-mono tabular-nums'
                        }
                      >
                        {row.httpStatus ?? t(`callLogs.${row.outcome}`)}
                      </span>
                    </span>
                  </td>
                  <td className="p-2">
                    {row.durationMs === undefined ? '—' : `${Math.round(row.durationMs)} ms`}
                  </td>
                  <td className="p-3">
                    <details className="min-w-40">
                      <summary className="cursor-pointer hub-sub">{t('callLogs.details')}</summary>
                      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                        {(
                          [
                            ['source', t(`callLogs.${row.source}`)],
                            ['category', row.category],
                            ['keyLabel', row.keyLabel],
                            ['target', row.target],
                            ['taskId', row.taskId],
                            [
                              'wait',
                              row.waitMs === undefined ? undefined : `${Math.round(row.waitMs)} ms`,
                            ],
                            [
                              'retryAt',
                              row.retryAt ? new Date(row.retryAt).toLocaleString() : undefined,
                            ],
                            ['requestId', row.id],
                          ] as const
                        )
                          .filter(([, value]) => value)
                          .map(([field, value]) => (
                            <div className="col-span-2 grid grid-cols-2 gap-3" key={field}>
                              <dt className="hub-sub">{t(`callLogs.${field}`)}</dt>
                              <dd className="break-all">{value}</dd>
                            </div>
                          ))}
                      </dl>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!!data?.total && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--hub-line)] px-4 py-3 text-xs hub-sub">
            <span>
              {t('pagination.showing', {
                from: (page - 1) * 50 + 1,
                to: Math.min(page * 50, data.total),
                total: data.total,
              })}
            </span>
            <nav aria-label={t('callLogs.pagination')} className="flex items-center gap-3">
              <button
                className="hub-btn sm"
                aria-label={t('callLogs.previousPage')}
                disabled={loading || page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <span className="tabular-nums">
                {t('callLogs.pageOf', { page, pages: Math.ceil(data.total / 50) })}
              </span>
              <button
                className="hub-btn sm"
                aria-label={t('callLogs.nextPage')}
                disabled={loading || page * 50 >= data.total}
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </nav>
          </div>
        )}
      </div>
    </section>
  );
}
