import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceSummary } from '../../../src/types/workspace';
import { apiPost, type ApiResponse } from '../utils/fetchInterceptor';

/** Run metadata only. Recovery never exports account material or run capabilities. */
export default function WorkspaceRunStatus({
  workspace,
  onRecovered,
}: {
  workspace: WorkspaceSummary;
  onRecovered: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const run = workspace.run ?? workspace.lastRun;
  const incomplete = !workspace.busy && workspace.ready === false;
  if (!run && !workspace.busy && !incomplete) return null;
  const time = (value?: number) =>
    value ? new Date(value).toLocaleString() : t('workspaceRun.unknown');
  const recover = async () => {
    if (!run || !window.confirm(t('workspaceRun.confirm'))) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await apiPost<ApiResponse>(
        `/workspace-credentials/${encodeURIComponent(workspace.catalog)}/${encodeURIComponent(workspace.name)}/release`,
        { runId: run.id, stopped: true, authorizationReviewed: true },
      );
      if (!result.success) throw new Error(result.message || t('workspaceCredentials.failed'));
      await onRecovered();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('workspaceCredentials.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 text-sm text-[var(--hub-ink-2)]" aria-live="polite">
      {incomplete && (
        <div className="hub-config-note" role="status">
          <p>{t('workspaceRun.incomplete')}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
            {workspace.missing?.map((field) => (
              <li key={field}>{field}</li>
            ))}
          </ul>
        </div>
      )}
      {(run || workspace.busy) && (
        <p className="hub-config-note">
          {workspace.busy
            ? t(
                workspace.expired || run?.state === 'recovery_required'
                  ? 'workspaceRun.recovery'
                  : 'workspaceRun.held',
              )
            : t('workspaceRun.released')}
        </p>
      )}
      {run && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-[var(--hub-ink-3)]">{t('workspaceRun.started')}</dt>
            <dd>{time(run.startedAt)}</dd>
          </div>
          <div>
            <dt className="text-[var(--hub-ink-3)]">{t('workspaceRun.heartbeat')}</dt>
            <dd>{time(run.heartbeatAt)}</dd>
          </div>
          <div>
            <dt className="text-[var(--hub-ink-3)]">{t('workspaceRun.synced')}</dt>
            <dd>{time(run.lastSyncAt)}</dd>
          </div>
          {run.endedAt && (
            <div>
              <dt className="text-[var(--hub-ink-3)]">{t('workspaceRun.ended')}</dt>
              <dd>{time(run.endedAt)}</dd>
            </div>
          )}
          {run.exitReason && (
            <div>
              <dt className="text-[var(--hub-ink-3)]">{t('workspaceRun.reason')}</dt>
              <dd>{t(`workspaceRun.${run.exitReason}`)}</dd>
            </div>
          )}
          {run.lastError && (
            <div>
              <dt className="text-[var(--hub-ink-3)]">{t('workspaceRun.error')}</dt>
              <dd>{t(`workspaceRun.${run.lastError}`)}</dd>
            </div>
          )}
        </dl>
      )}
      {workspace.busy && run && (
        <button
          type="button"
          className="hub-btn danger"
          disabled={busy}
          onClick={() => void recover()}
        >
          {t('workspaceRun.recover')}
        </button>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
