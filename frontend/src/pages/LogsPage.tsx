import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import CallLogViewer from '../components/CallLogViewer';
import { useTranslation } from 'react-i18next';
import LogViewer from '../components/LogViewer';
import { useLogs } from '../services/logService';
import { checkActivityAvailable } from '../services/activityService';
const ActivityPage = lazy(() => import('./ActivityPage'));
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
  const [activityAvailable, setActivityAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void checkActivityAvailable().then((value) => {
      if (active) setActivityAvailable(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div>
      <div className="mb-6">
        <h1 className="hub-h1">{t('callLogs.title')}</h1>
      </div>
      <div className="mb-4 flex flex-wrap gap-3" role="tablist">
        {['calls', ...(activityAvailable ? ['activity'] : []), 'runtime'].map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={`rounded border px-4 py-2 ${tab === value ? 'font-bold' : ''}`}
            onClick={() => setSearch(value === 'calls' ? {} : { view: value })}
          >
            {t(`callLogs.${value}`)}
          </button>
        ))}
      </div>
      {tab === 'activity' ? (
        activityAvailable ? (
          <Suspense fallback={<p>{t('common.loading')}</p>}>
            <ActivityPage embedded />
          </Suspense>
        ) : (
          <p>{t('callLogs.activityUnavailable')}</p>
        )
      ) : (
        <div className="hub-card overflow-hidden">
          {tab === 'calls' ? <CallLogViewer /> : <RuntimeLogs />}
        </div>
      )}
    </div>
  );
};
export default LogsPage;
