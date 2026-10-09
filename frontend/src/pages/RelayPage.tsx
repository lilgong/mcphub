import RelayLimits from '../components/RelayLimits';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { apiGet, apiPut, apiPost } from '@/utils/fetchInterceptor';
import type { AtlasConfig } from '../../../src/types/atlas';

type Settings = AtlasConfig & {
  hasRelayToken: boolean;

  servers: string[];
  stats: Record<string, { active: number; queued: number; cooldownMs: number }>;
};
const inputClass =
  'hub-input w-full rounded border border-[var(--hub-line)] bg-[var(--hub-surface)] p-2';

export default function RelayPage() {
  const { t } = useTranslation();
  const { auth } = useAuth();
  const [settings, setSettings] = useState<Settings>();
  const [config, setConfig] = useState<AtlasConfig>();
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const load = useCallback(
    async (reset = false) => {
      try {
        const result = await apiGet<{ success: boolean; data: Settings }>('/relay/config');
        if (!result.success) throw new Error();
        setSettings(result.data);
        if (reset) {
          setConfig({ policies: result.data.policies, relay: result.data.relay });
        }
      } catch {
        setMessage(t('atlas.failed'));
      }
    },
    [t],
  );
  useEffect(() => {
    if (!auth.user?.isAdmin) return;
    void load(true);
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [auth.user?.isAdmin, load]);
  if (!auth.user?.isAdmin) return <p>{t('atlas.adminOnly')}</p>;
  if (!config || !settings) return <p>{message || t('app.loading')}</p>;
  const changeRelay = (value: Partial<AtlasConfig['relay']>) =>
    setConfig({ ...config, relay: { ...config.relay, ...value } });
  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      const result = await apiPut<{ success: boolean; data: { reconnectFailed: string[] } }>(
        '/relay/config',
        { config, relayToken: token, clearRelayToken: clearToken },
      );
      if (!result.success) throw new Error();
      setToken('');
      setClearToken(false);
      setMessage(
        result.data.reconnectFailed.length
          ? t('atlas.reconnectFailed', { servers: result.data.reconnectFailed.join(', ') })
          : t('atlas.saved'),
      );
      await load();
    } catch {
      setMessage(t('atlas.failed'));
    } finally {
      setSaving(false);
    }
  };
  const checkRelay = async () => {
    try {
      const result = await apiPost<{ success: boolean }>('/relay/health', {});
      setMessage(t(result.success ? 'atlas.reachable' : 'atlas.failed'));
    } catch {
      setMessage(t('atlas.failed'));
    }
  };
  return (
    <div className="space-y-6 text-[var(--hub-ink)]">
      <div>
        <h1 className="text-2xl font-semibold">{t('atlas.title')}</h1>
        <p className="mt-2 text-sm text-[var(--hub-ink-2)]">{t('atlas.description')}</p>
      </div>
      <section className="space-y-4 rounded-lg border border-[var(--hub-line)] p-5">
        <h2 className="font-semibold">{t('atlas.relay')}</h2>
        <p className="text-sm text-[var(--hub-ink-2)]">{t('atlas.relayDescription')}</p>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={config.relay.enabled}
            onChange={(e) => changeRelay({ enabled: e.target.checked })}
          />
          {t('atlas.relayEnabled')}
        </label>
        <label className="block">
          {t('atlas.relayUrl')}
          <input
            className={inputClass}
            value={config.relay.url}
            placeholder="http://host.docker.internal:PORT"
            onChange={(e) => changeRelay({ url: e.target.value })}
          />
        </label>
        <label className="block">
          {t('atlas.relayToken')}
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={token}
            placeholder={t(settings.hasRelayToken ? 'atlas.tokenConfigured' : 'atlas.tokenMissing')}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={clearToken}
            onChange={(e) => setClearToken(e.target.checked)}
          />
          {t('atlas.clearToken')}
        </label>
        <label className="block">
          {t('atlas.relayTimeout')}
          <input
            className={inputClass}
            type="number"
            min="1"
            max="600"
            value={config.relay.timeoutSeconds}
            onChange={(e) => changeRelay({ timeoutSeconds: Number(e.target.value) })}
          />
        </label>
        <button className="rounded border border-[var(--hub-line)] px-4 py-2" onClick={checkRelay}>
          {t('atlas.checkRelay')}
        </button>
      </section>
      <RelayLimits />
      <button
        disabled={saving}
        onClick={save}
        className="rounded bg-[var(--hub-accent)] px-4 py-2 text-white disabled:opacity-50"
      >
        {t('common.save')}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
