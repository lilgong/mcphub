import SettingHint from './SettingHint';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../utils/fetchInterceptor';
import { useTranslation } from 'react-i18next';
import type { ServiceRateLimit, FetchRelayConfig } from '../../../src/types/serviceControls';

const fields = [
  'maxCalls',
  'windowMs',
  'minIntervalMs',
  'concurrency',
  'queueTimeoutMs',
  'maxQueued',
  'rateLimitBackoffMs',
  'maxBackoffMs',
] as const;
export default function ServiceControls({
  hideRateLimit = false,
  rateLimit,
  relay,
  stdio,
  relaySupported = false,
  onChange,
}: {
  hideRateLimit?: boolean;
  rateLimit?: ServiceRateLimit;
  relay?: FetchRelayConfig;
  stdio: boolean;
  relaySupported?: boolean;
  onChange: (value: { rateLimit?: ServiceRateLimit; relay?: FetchRelayConfig }) => void;
}) {
  const { t } = useTranslation();
  const [relayDefault, setRelayDefault] = useState<boolean>();
  useEffect(() => {
    if (!stdio || !relaySupported) return;
    let active = true;
    void apiGet<{
      success: boolean;
      data: { relay: { enabled: boolean }; hasRelayToken: boolean };
    }>('/relay/config')
      .then((result) => {
        if (active && result.success)
          setRelayDefault(result.data.relay.enabled && result.data.hasRelayToken);
      })
      .catch(() => {
        if (active) setRelayDefault(false);
      });
    return () => {
      active = false;
    };
  }, [stdio, relaySupported]);
  const policy = rateLimit ?? { enabled: false };
  const renderFields = (names: readonly (typeof fields)[number][]) => (
    <div className="hub-config-fields grid grid-cols-1 gap-4 sm:grid-cols-2">
      {names.map((field) => (
        <label key={field} className="text-sm">
          {t(`serviceControls.${field}`)}
          <input
            aria-label={t(`serviceControls.${field}`)}
            className="hub-input"
            type="number"
            min="1"
            step="1"
            placeholder={t('serviceControls.unset')}
            value={policy[field] ?? ''}
            onChange={(e) =>
              onChange({
                rateLimit: {
                  ...policy,
                  [field]: e.target.value === '' ? undefined : Number(e.target.value),
                },
              })
            }
          />
        </label>
      ))}
    </div>
  );
  return (
    <>
      {!hideRateLimit && (
        <section className="hub-setting-section">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="hub-setting-heading mb-0">
              <h4>{t('uiLayout.frequency')}</h4>
              <SettingHint label={t('editorHints.details', { name: t('uiLayout.frequency') })}>
                {t('uiLayout.mcpScope')} {t('uiLayout.frequencyHint')}
              </SettingHint>
            </div>
            <label className="hub-checkbox-label">
              <input
                type="checkbox"
                checked={policy.enabled}
                onChange={(e) => onChange({ rateLimit: { ...policy, enabled: e.target.checked } })}
              />
              {t('callSettings.enableLimits')}
            </label>
          </div>
          {policy.enabled && (
            <>
              {renderFields(['maxCalls', 'windowMs', 'minIntervalMs', 'concurrency'])}
              <details className="hub-setting-advanced">
                <summary>{t('callSettings.queueAdvanced')}</summary>
                <p className="hub-config-note mb-4">{t('uiLayout.queueHint')}</p>
                {renderFields([
                  'maxQueued',
                  'queueTimeoutMs',
                  'rateLimitBackoffMs',
                  'maxBackoffMs',
                ])}
              </details>
            </>
          )}
        </section>
      )}
      {stdio && (
        <div className="hub-relay-inline flex flex-wrap items-center gap-x-3 gap-y-2">
          {relaySupported ? (
            <>
              <label className="hub-checkbox-label">
                <input
                  type="checkbox"
                  checked={relay?.enabled ?? relayDefault ?? false}
                  disabled={relayDefault === undefined && relay === undefined}
                  onChange={(e) => onChange({ relay: { ...relay, enabled: e.target.checked } })}
                />
                {t('uiLayout.useRelay')}
              </label>
              <SettingHint label={t('editorHints.details', { name: 'Relay' })}>
                {t('callSettings.relayHelp')}
                {relayDefault === false && (
                  <p className="mt-2">{t('serviceControls.relayNotConfigured')}</p>
                )}
              </SettingHint>
              <Link className="text-xs text-[var(--hub-accent)] hover:underline" to="/relay">
                {t('callSettings.relaySettings')}
              </Link>
            </>
          ) : (
            <>
              <span className="text-sm text-[var(--hub-ink-2)]">Relay</span>
              <span className="text-xs text-[var(--hub-ink-3)]">
                {t('callSettings.unsupported')}
              </span>
              <SettingHint label={t('editorHints.details', { name: 'Relay' })} unavailable>
                {t('serviceControls.relayUnsupported')}
              </SettingHint>
            </>
          )}
        </div>
      )}
    </>
  );
}
