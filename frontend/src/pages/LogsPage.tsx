import React from 'react';
import { useSearchParams } from 'react-router-dom';
import CallLogViewer from '../components/CallLogViewer';
import { useTranslation } from 'react-i18next';
import LogViewer from '../components/LogViewer';
import { useLogs } from '../services/logService';
import CallStatistics from '../components/CallStatistics';
// Subscribe to the runtime stream only while its view is open.
const RuntimeLogs = () => {
  const { logs, loading, error, clearLogs } = useLogs();
  return <LogViewer logs={logs} isLoading={loading} error={error} onClear={clearLogs} />;
};
const LogsPage: React.FC = () => {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const tab = ['activity', 'runtime'].includes(search.get('view') || '')
    ? search.get('view')!
    : 'calls';
  return (
    <div>
      <div className="mb-6">
        <h1 className="hub-h1">{t('callLogs.title')}</h1>
      </div>
      <div
        className="mb-4 inline-flex flex-wrap items-center gap-1 rounded-lg border border-[var(--hub-line)] bg-[var(--hub-bg)] p-1"
        role="tablist"
      >
        {['calls', 'activity', 'runtime'].map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--hub-ink-3)] ${
              tab === value
                ? 'bg-[var(--hub-surface)] text-[var(--hub-ink)] shadow-sm'
                : 'text-[var(--hub-ink-2)] hover:bg-[var(--hub-surface-hover)] hover:text-[var(--hub-ink)]'
            }`}
            onClick={() => setSearch(value === 'calls' ? {} : { view: value })}
          >
            {t(`callLogs.${value}`)}
          </button>
        ))}
      </div>
      {tab === 'activity' ? (
        <CallStatistics />
      ) : (
        <div className="hub-card overflow-hidden">
          {tab === 'calls' ? <CallLogViewer /> : <RuntimeLogs />}
        </div>
      )}
    </div>
  );
};
export default LogsPage;
