import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Play, Square, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiGet, apiPost } from '@/utils/fetchInterceptor';
import ConfirmDialog from './ui/ConfirmDialog';
import type { RelayRuntimeStatus } from '../../../src/types/relayRuntime';

type Result = {
  success: boolean;
  message?: string;
  data?: { token?: string; reconnectFailed?: string[] };
};

export default function RelayRuntime({ onChange }: { onChange: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RelayRuntimeStatus>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  const [confirm, setConfirm] = useState<'stop' | 'reset-token'>();
  const load = useCallback(async () => {
    const result = await apiGet<{ success: boolean; data: RelayRuntimeStatus }>('/relay/runtime');
    if (result.success) setStatus(result.data);
    else setMessage(t('atlas.failed'));
  }, [t]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const action = async (name: string) => {
    setBusy(true);
    setConfirm(undefined);
    setMessage('');
    setToken('');
    setVisible(false);
    try {
      const result = await apiPost<Result>(`/relay/runtime/${name}`, {});
      if (!result.success) {
        setMessage(result.message || t('atlas.failed'));
        return;
      }
      if (result.data?.token) setToken(result.data.token);
      setMessage(
        result.data?.reconnectFailed?.length
          ? t('atlas.reconnectFailed', { servers: result.data.reconnectFailed.join(', ') })
          : t(
              `relayRuntime.${name === 'reset-token' ? 'tokenReset' : name === 'start' ? 'started' : 'stopped'}`,
            ),
      );
      onChange();
      await load();
    } finally {
      setBusy(false);
    }
  };
  const external = status?.state === 'external';
  return (
    <section className="hub-card space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="hub-card-title">{t('relayRuntime.title')}</h2>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            status?.state === 'running' && status.healthy
              ? 'bg-emerald-500/10 text-emerald-600'
              : 'bg-[var(--hub-surface-2)] text-[var(--hub-ink-2)]'
          }`}
        >
          {status ? t(`relayRuntime.state.${status.state}`) : t('app.loading')}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-[var(--hub-ink-2)]">
        {t('relayRuntime.description')}
      </p>
      {external && (
        <p className="text-sm leading-relaxed text-[var(--hub-ink-2)]">
          {t('relayRuntime.externalHint')}
        </p>
      )}
      {status && !status.configured && (
        <p className="text-sm text-amber-600">
          {t('relayRuntime.missing', { names: status.missing.join(', ') })}
        </p>
      )}
      {status?.lastError && <p className="text-sm text-amber-600">{status.lastError}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          className="hub-btn primary"
          disabled={busy || !status?.configured || external || status.state === 'running'}
          onClick={() => void action('start')}
        >
          <Play className="h-4 w-4" />
          {t('relayRuntime.start')}
        </button>
        <button
          className="hub-btn"
          disabled={busy || status?.state !== 'running'}
          onClick={() => setConfirm('stop')}
        >
          <Square className="h-4 w-4" />
          {t('relayRuntime.stop')}
        </button>
        <button
          className="hub-btn"
          disabled={busy || !status || external}
          onClick={() => setConfirm('reset-token')}
        >
          <KeyRound className="h-4 w-4" />
          {t('relayRuntime.resetToken')}
        </button>
        <button className="hub-btn" disabled={busy} onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" />
          {t('common.refresh')}
        </button>
      </div>
      {token && (
        <div className="space-y-2">
          <p className="text-sm leading-relaxed text-[var(--hub-ink-2)]">
            {t('relayRuntime.tokenOnce')}
          </p>
          <div className="flex items-center gap-2">
            <input
              className="hub-input min-w-0 flex-1 font-mono text-sm"
              type={visible ? 'text' : 'password'}
              value={token}
              readOnly
              autoComplete="off"
            />
            <button
              className="hub-btn"
              aria-label={t(visible ? 'relayRuntime.hideToken' : 'relayRuntime.showToken')}
              onClick={() => setVisible(!visible)}
            >
              {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}
      {message && (
        <p className="text-sm leading-relaxed text-[var(--hub-ink-2)]" role="status">
          {message}
        </p>
      )}
      <ConfirmDialog
        isOpen={Boolean(confirm)}
        onClose={() => setConfirm(undefined)}
        onConfirm={() => confirm && void action(confirm)}
        confirmDisabled={busy}
        title={t(confirm === 'stop' ? 'relayRuntime.stop' : 'relayRuntime.resetToken')}
        message={t(confirm === 'stop' ? 'relayRuntime.stopConfirm' : 'relayRuntime.resetConfirm')}
      />
    </section>
  );
}
