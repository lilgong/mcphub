import RelayRuntime from '../components/RelayRuntime';
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
const inputClass = 'hub-input';

export default function RelayPage() {
  const { t } = useTranslation();
  const { auth } = useAuth();
  const [settings, setSettings] = useState<Settings>();
  const [config, setConfig] = useState<AtlasConfig>();
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [deployment, setDeployment] = useState<'external' | 'managed'>();
  const [runtime, setRuntime] = useState<{ state: string; healthy: boolean }>();
  const load = useCallback(
    async (reset = false) => {
      try {
        const [result, running] = await Promise.all([
          apiGet<{ success: boolean; data: Settings }>('/relay/config'),
          apiGet<{ success: boolean; data: { state: string; healthy: boolean } }>('/relay/runtime'),
        ]);
        if (running.success) {
          setRuntime(running.data);
          setDeployment(
            (current) => current ?? (running.data.state === 'running' ? 'managed' : 'external'),
          );
        }
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
  const saveErrorMessage = (message?: string) => {
    if (message === 'A relay token is required') return t('atlas.tokenRequired');
    if (message?.startsWith('Relay Token must not contain whitespace'))
      return t('atlas.invalidToken');
    return message || t('atlas.failed');
  };
  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      const result = await apiPut<{
        success: boolean;
        message?: string;
        data: { reconnectFailed: string[] };
      }>('/relay/config', { config, relayToken: token, clearRelayToken: clearToken });
      if (!result.success) throw new Error(saveErrorMessage(result.message));
      const verified = await apiGet<{ success: boolean; data: Settings }>('/relay/config');
      if (
        !verified.success ||
        verified.data.relay.enabled !== config.relay.enabled ||
        verified.data.relay.url !== config.relay.url.trim().replace(/\/+$/, '') ||
        (config.relay.enabled && !verified.data.hasRelayToken)
      ) {
        throw new Error(t('atlas.saveNotConfirmed'));
      }
      setSettings(verified.data);
      setConfig({ policies: verified.data.policies, relay: verified.data.relay });
      setToken('');
      setClearToken(false);
      setMessage(
        result.data.reconnectFailed.length
          ? t('atlas.reconnectFailed', { servers: result.data.reconnectFailed.join(', ') })
          : t('atlas.saved'),
      );
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('atlas.failed'));
    } finally {
      setSaving(false);
    }
  };
  const checkRelay = async () => {
    try {
      const result = await apiPost<{ success: boolean; message?: string }>('/relay/health', {
        config,
      });
      setMessage(result.success ? t('atlas.reachable') : result.message || t('atlas.failed'));
    } catch {
      setMessage(t('atlas.failed'));
    }
  };
  return (
    <div className="hub-relay-page max-w-4xl space-y-5 text-[var(--hub-ink)]">
      <div>
        <h1 className="hub-h1">{t('atlas.title')}</h1>
        <p className="mt-2 text-sm text-[var(--hub-ink-2)]">{t('atlas.description')}</p>
      </div>
      <dl className="hub-scope-map">
        <div>
          <dt>{t('uiLayout.hubProtection')}</dt>
          <dd>{t('uiLayout.hubProtectionHint')}</dd>
        </div>
        <div>
          <dt>{t('uiLayout.mcpLimits')}</dt>
          <dd>{t('uiLayout.mcpLimitsLink')}</dd>
        </div>
        <div>
          <dt>{t('uiLayout.upstreamLimits')}</dt>
          <dd>{t('uiLayout.upstreamScope')}</dd>
        </div>
      </dl>
      <section>
        <h2 className="hub-editor-heading">{t('uiLayout.relayDeployment')}</h2>
        <div className="hub-mode-tabs" role="group" aria-label={t('uiLayout.relayDeployment')}>
          {(['external', 'managed'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`hub-mode-tab ${deployment === mode ? 'is-active' : ''}`}
              aria-pressed={deployment === mode}
              onClick={() => setDeployment(mode)}
            >
              {t(`uiLayout.relay_${mode}`)}
            </button>
          ))}
        </div>
        <p className="hub-config-note">
          {t(deployment === 'managed' ? 'uiLayout.managedHint' : 'uiLayout.externalHint')}
        </p>
        <p className="hub-sub mt-2">
          {t('uiLayout.currentState')}:{' '}
          {runtime ? t(`relayRuntime.state.${runtime.state}`) : t('app.loading')}
          {runtime?.healthy ? ` · ${t('status.online')}` : ''}
        </p>
        <div className="hub-relay-connection-status" role="status">
          <span
            className={`hub-status ${settings.relay.enabled && settings.hasRelayToken && runtime?.healthy ? 'ok' : 'muted'}`}
          >
            <span className="hub-dot" />
            {t(
              settings.relay.enabled && settings.hasRelayToken && runtime?.healthy
                ? 'relayIndicators.connected'
                : 'relayIndicators.notConnected',
            )}
          </span>
          {settings.relay.enabled && settings.hasRelayToken && (
            <span className="break-all text-xs">{settings.relay.url}</span>
          )}
          <p className="hub-config-note text-xs">{t('relayIndicators.routingHint')}</p>
        </div>
      </section>
      {deployment === 'managed' ? (
        <RelayRuntime
          onChange={() => void load(true)}
          onExternal={() => setDeployment('external')}
        />
      ) : (
        <section className="space-y-4">
          <h2 className="hub-editor-heading">{t('uiLayout.externalConnection')}</h2>
          <p className="text-sm text-[var(--hub-ink-2)]">{t('atlas.relayDescription')}</p>
          <label className="hub-checkbox-label">
            <input
              type="checkbox"
              checked={config.relay.enabled}
              onChange={(e) => changeRelay({ enabled: e.target.checked })}
            />
            {t('atlas.relayEnabled')}
          </label>
          <label className="hub-field">
            <span className="hub-label">{t('atlas.relayUrl')}</span>
            <input
              className={inputClass}
              value={config.relay.url}
              placeholder="http://host.docker.internal:PORT"
              onChange={(e) => changeRelay({ url: e.target.value })}
            />
          </label>
          <label className="hub-field">
            <span className="hub-label">{t('atlas.relayToken')}</span>
            <input
              className={inputClass}
              type="password"
              autoComplete="new-password"
              value={token}
              placeholder={t(
                settings.hasRelayToken ? 'atlas.tokenConfigured' : 'atlas.tokenMissing',
              )}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <label className="hub-checkbox-label">
            <input
              type="checkbox"
              checked={clearToken}
              onChange={(e) => setClearToken(e.target.checked)}
            />
            {t('atlas.clearToken')}
          </label>
          <label className="hub-field max-w-xs">
            <span className="hub-label">{t('atlas.relayTimeout')}</span>
            <input
              className={inputClass}
              type="number"
              min="1"
              max="600"
              value={config.relay.timeoutSeconds}
              onChange={(e) => changeRelay({ timeoutSeconds: Number(e.target.value) })}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button disabled={saving} onClick={save} className="hub-btn primary">
              {t('uiLayout.saveExternal')}
            </button>
            <button className="hub-btn" onClick={checkRelay}>
              {t('atlas.checkRelay')}
            </button>
          </div>
          <p className="hub-sub text-xs">{t('atlas.connectionOnly')}</p>
          {message && <p role="status">{message}</p>}
        </section>
      )}
      <RelayLimits />
    </div>
  );
}
