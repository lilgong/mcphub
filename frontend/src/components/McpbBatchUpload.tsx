import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, FileArchive, Loader2, X } from 'lucide-react';
import CatalogInput from './CatalogInput';
import { apiGet, apiPost, apiPut, fetchWithInterceptors } from '@/utils/fetchInterceptor';
import { getApiUrl } from '@/utils/runtime';
import { convertMcpbToMcpConfig } from '../utils/mcpbConfig';
import { mcpServerPath, validateServerKey } from '../../../src/utils/catalog';

type Status = 'pending' | 'uploading' | 'ready' | 'installing' | 'done' | 'failed' | 'skipped';
type Action = 'overwrite' | 'skip';
interface Item {
  file: File;
  status: Status;
  name?: string;
  version?: string;
  conflict?: boolean;
  action: Action;
  error?: string;
}
interface Props {
  files: File[];
  defaultCatalog: string;
  onSuccess: (config: unknown) => void;
  onCancel: () => void;
}

export default function McpbBatchUpload({ files, defaultCatalog, onSuccess, onCancel }: Props) {
  const { t } = useTranslation();
  const initialItems = (): Item[] =>
    files.map((file) => ({ file, status: 'pending', action: 'skip' }));
  const [catalog, setCatalog] = useState(defaultCatalog);
  const [items, setItems] = useState<Item[]>(initialItems);
  const [busy, setBusy] = useState(false);
  const [inspected, setInspected] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState('');
  const update = (index: number, value: Partial<Item>) =>
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...value } : item)));

  const sendFile = async (file: File, inspectOnly: boolean, overwrite = false) => {
    const data = new FormData();
    data.append('catalog', catalog);
    data.append('inspectOnly', String(inspectOnly));
    if (!inspectOnly && !overwrite) data.append('skipExisting', 'true');
    data.append('mcpbFile', file);
    const response = await fetchWithInterceptors(getApiUrl('/mcpb/upload'), {
      method: 'POST',
      body: data,
    });
    const result = await response.json();
    if (!response.ok || !result.success)
      throw Object.assign(new Error(result.message || t('mcpb.uploadFailed')), {
        status: response.status,
      });
    return result.data;
  };

  const inspect = async () => {
    const identity = validateServerKey('upload', catalog);
    if (!identity.valid) {
      setError(identity.message || 'Invalid namespace');
      return;
    }
    setError('');
    setBusy(true);
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      update(index, { status: 'uploading', error: undefined });
      try {
        const { manifest, exists } = await sendFile(item.file, true);
        const key = validateServerKey(manifest.name, catalog);
        if (!key.valid) throw new Error(key.message);
        if (seen.has(key.normalized!)) throw new Error(t('mcpb.duplicateBatch'));
        seen.add(key.normalized!);
        update(index, {
          status: 'ready',
          name: key.normalized,
          version: manifest.version,
          conflict: exists,
          action: exists ? 'skip' : 'overwrite',
        });
      } catch (cause) {
        update(index, {
          status: 'failed',
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    setInspected(true);
    setBusy(false);
  };

  const install = async () => {
    if (items.some((item) => item.status === 'ready' && item.conflict && !item.action)) return;
    setBusy(true);
    for (const [index, item] of items.entries()) {
      if (item.status !== 'ready') continue;
      if (item.action === 'skip') {
        update(index, { status: 'skipped' });
        continue;
      }
      update(index, { status: 'installing', error: undefined });
      try {
        // Recheck registration state before replacing any executable files.
        const list = await apiGet('/servers');
        if (!list.success) throw new Error(list.message || t('mcpb.installFailed'));
        const registered = list.data.some((server: { name: string }) => server.name === item.name);
        if (registered && item.action !== 'overwrite') {
          update(index, { conflict: true, action: 'skip' });
          throw new Error(t('mcpb.conflictChanged'));
        }
        let existingConfig: Record<string, any> = {};
        if (registered) {
          const current = await apiGet(`/servers/${encodeURIComponent(item.name!)}`);
          if (!current.success) throw new Error(current.message || t('mcpb.installFailed'));
          existingConfig = current.data.config;
        }
        setChanged(true);
        const { manifest, extractDir } = await sendFile(
          item.file,
          false,
          item.action === 'overwrite',
        );
        const bundleConfig = convertMcpbToMcpConfig(manifest, extractDir, item.name!);
        const config = {
          ...existingConfig,
          ...bundleConfig,
          env: { ...bundleConfig.env, ...existingConfig.env },
        };
        const result = registered
          ? await apiPut(`/servers/${encodeURIComponent(item.name!)}`, { config })
          : await apiPost('/servers', { name: item.name, config });
        if (!result.success) throw new Error(result.message || t('mcpb.installFailed'));
        update(index, { status: 'done' });
      } catch (cause) {
        if (cause instanceof Error && 'status' in cause && cause.status === 409)
          update(index, { conflict: true, action: 'skip' });
        update(index, {
          status: 'ready',
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    setBusy(false);
  };
  const conflicts = items.filter((item) => item.status === 'ready' && item.conflict);
  const unresolved = conflicts.some((item) => !item.action);
  const actionable = items.some((item) => item.status === 'ready');
  const finished = items.filter((item) => item.status === 'done').length;
  const close = () => (changed ? onSuccess({}) : onCancel());
  const chooseAll = (action: Action) =>
    setItems((current) =>
      current.map((item) =>
        item.conflict && item.status === 'ready' ? { ...item, action } : item,
      ),
    );

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-upload-title"
        className="hub-card w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
      >
        <div className="flex items-start justify-between px-6 py-5 hub-border-b">
          <div>
            <h2 id="batch-upload-title" className="text-lg font-semibold">
              {t('mcpb.batchTitle')}
            </h2>
            <p className="hub-sub mt-1">
              {t('mcpb.batchSummary', {
                count: files.length,
                size: (files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1),
              })}
            </p>
          </div>
          <button
            className="hub-icon-btn"
            aria-label={t('common.close')}
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-4 overflow-y-auto">
          <CatalogInput
            value={catalog}
            onChange={setCatalog}
            disabled={busy || inspected}
            help={t('mcpb.destinationHelp')}
          />
          <p className="hub-sub text-sm mb-4">{t('mcpb.batchHelp')}</p>
          {error && (
            <p role="alert" className="text-red-600 mb-3">
              {error}
            </p>
          )}
          {conflicts.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3 text-sm">
              <span>{t('mcpb.conflictCount', { count: conflicts.length })}</span>
              <div className="flex gap-2">
                <button className="hub-btn" disabled={busy} onClick={() => chooseAll('skip')}>
                  {t('mcpb.skipAll')}
                </button>
                <button className="hub-btn" disabled={busy} onClick={() => chooseAll('overwrite')}>
                  {t('mcpb.overwriteAll')}
                </button>
              </div>
            </div>
          )}
          <ul className="hub-border rounded-lg overflow-hidden hub-divider">
            {items.map((item, index) => (
              <li
                key={index}
                className="px-4 py-3 grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 gap-y-2 sm:flex sm:items-center"
                data-file={item.file.name}
              >
                <FileArchive size={19} className="shrink-0 text-[var(--hub-ink-3)]" />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap gap-x-2 items-baseline">
                    <span className="text-sm font-medium break-all">{item.file.name}</span>
                    {item.version && (
                      <span className="text-xs text-[var(--hub-ink-3)]">v{item.version}</span>
                    )}
                  </div>
                  {item.name && (
                    <div className="text-xs text-[var(--hub-ink-3)] mt-1 break-all">
                      {mcpServerPath(item.name)}
                    </div>
                  )}
                  {item.error && (
                    <p role="alert" className="text-red-600 text-xs mt-1">
                      {item.error}
                    </p>
                  )}
                </div>
                <div className="col-start-2 flex flex-wrap items-center justify-between gap-3 text-xs sm:justify-start sm:shrink-0">
                  {item.status === 'uploading' || item.status === 'installing' ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : item.status === 'done' ? (
                    <Check size={15} className="text-[var(--hub-ok)]" />
                  ) : null}
                  <span
                    className={
                      item.conflict && item.status === 'ready'
                        ? 'text-[var(--hub-ink)]'
                        : 'text-[var(--hub-ink-3)]'
                    }
                  >
                    {item.conflict && item.status === 'ready'
                      ? t('mcpb.conflict')
                      : t(`mcpb.batchStatus.${item.status}`)}
                  </span>
                  {item.conflict && item.status === 'ready' && (
                    <select
                      className="hub-input"
                      style={{ width: 128 }}
                      aria-label={t('mcpb.conflictAction', { name: item.name })}
                      value={item.action}
                      disabled={busy}
                      onChange={(event) => update(index, { action: event.target.value as Action })}
                    >
                      <option value="skip">{t('mcpb.skip')}</option>
                      <option value="overwrite">{t('mcpb.updateBundle')}</option>
                    </select>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="px-6 py-4 hub-border-t flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-[var(--hub-ink-3)]">
            {unresolved
              ? t('mcpb.resolveConflicts')
              : finished
                ? t('mcpb.installedCount', { count: finished })
                : t('mcpb.inspectHelp')}
          </p>
          <div className="flex gap-2">
            <button className="hub-btn" disabled={busy} onClick={close}>
              {changed ? t('common.close') : t('common.cancel')}
            </button>
            {inspected && !changed && (
              <button
                className="hub-btn"
                disabled={busy}
                onClick={() => {
                  setItems(initialItems());
                  setInspected(false);
                }}
              >
                {t('common.back')}
              </button>
            )}
            {!inspected && (
              <button className="hub-btn primary" disabled={busy} onClick={inspect}>
                {busy ? t('mcpb.checking') : t('mcpb.inspect')}
              </button>
            )}
            {inspected && actionable && (
              <button className="hub-btn primary" disabled={busy || unresolved} onClick={install}>
                {t('mcpb.batchInstall')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
