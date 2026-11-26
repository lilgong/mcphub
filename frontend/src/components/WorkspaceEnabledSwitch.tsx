import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceSummary } from '../../../src/types/workspace';
import { apiPut, type ApiResponse } from '../utils/fetchInterceptor';

/** Account admission can be paused without interrupting an existing run. */
export default function WorkspaceEnabledSwitch({
  workspace,
  disabled,
  onChanged,
}: {
  workspace: WorkspaceSummary;
  disabled?: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const enabled = workspace.enabled !== false;
  const toggle = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await apiPut<ApiResponse>(
        `/workspace-credentials/${encodeURIComponent(workspace.catalog)}/${encodeURIComponent(workspace.name)}/enabled`,
        { enabled: !enabled, revision: workspace.revision },
      );
      if (!result.success) throw new Error(result.message || t('workspaceCredentials.failed'));
      await onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : t('workspaceCredentials.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={t('workspaceCredentials.accountEnabled')}
        title={t('workspaceCredentials.enabledHelp')}
        disabled={busy || disabled}
        onClick={() => void toggle()}
        className="hub-btn"
      >
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${enabled ? 'bg-emerald-500' : 'bg-slate-400'}`}
        />
        {t(enabled ? 'workspaceCredentials.enabled' : 'workspaceCredentials.disabled')}
      </button>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
