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
        <section className="hub-editor-section">
          <div className="flex items-center justify-between gap-4 mb-3">
            <h4 className="hub-editor-heading mb-0">{t('uiLayout.mcpLimits')}</h4>
            <label className="hub-checkbox-label">
              <input
                type="checkbox"
                checked={policy.enabled}
                onChange={(e) => onChange({ rateLimit: { ...policy, enabled: e.target.checked } })}
              />
              {t('serviceControls.enabled')}
            </label>
          </div>
          <p className="hub-config-note mb-4">{t('uiLayout.mcpScope')}</p>
          {policy.enabled && (
            <>
              <div className="hub-control-group">
                <h5>{t('uiLayout.frequency')}</h5>
                <p>{t('uiLayout.frequencyHint')}</p>
                {renderFields(['maxCalls', 'windowMs', 'minIntervalMs', 'concurrency'])}
              </div>
              <div className="hub-control-group">
                <h5>{t('uiLayout.queue')}</h5>
                <p>{t('uiLayout.queueHint')}</p>
                {renderFields(['maxQueued', 'queueTimeoutMs'])}
              </div>
              <details className="hub-config-advanced">
                <summary>{t('uiLayout.cooldown')}</summary>
                {renderFields(['rateLimitBackoffMs', 'maxBackoffMs'])}
              </details>
            </>
          )}
        </section>
      )}
      {stdio && (
        <div className="hub-relay-inline">
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
              <p className="hub-config-note">
                {t('uiLayout.relayScope')}{' '}
                <Link className="text-[var(--hub-accent)] hover:underline" to="/relay">
                  {t('atlas.title')}
                </Link>
              </p>
              {relayDefault === false && (
                <p className="hub-config-note">{t('serviceControls.relayNotConfigured')}</p>
              )}
            </>
          ) : (
            <p className="hub-config-note">{t('serviceControls.relayUnsupported')}</p>
          )}
        </div>
      )}
    </>
  );
}
