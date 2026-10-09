import React, { useState } from 'react';
import CallLogViewer from '../components/CallLogViewer';
import { useTranslation } from 'react-i18next';
import LogViewer from '../components/LogViewer';
import { useLogs } from '../services/logService';

const LogsPage: React.FC = () => {
  const { t } = useTranslation();
  const [tab, setTab] = useState('calls');
  const { logs, loading, error, clearLogs } = useLogs();

  return (
    <div>
      <div className="mb-6">
        <h1 className="hub-h1">{t('pages.logs.title')}</h1>
        <p className="hub-sub">
          <span className="hub-num">{logs.length}</span> entries
        </p>
      </div>
      <div className="mb-4 flex gap-3">
        {['calls', 'runtime'].map((value) => (
          <button
            key={value}
            className={`rounded border px-4 py-2 ${tab === value ? 'font-bold' : ''}`}
            onClick={() => setTab(value)}
          >
            {t(`callLogs.${value}`)}
          </button>
        ))}
      </div>
      <div className="hub-card overflow-hidden">
        {tab === 'calls' ? (
          <CallLogViewer />
        ) : (
          <>
            <LogViewer logs={logs} isLoading={loading} error={error} onClear={clearLogs} />
          </>
        )}
      </div>
    </div>
  );
};

export default LogsPage;
