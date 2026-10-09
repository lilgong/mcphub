import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../utils/fetchInterceptor';
import { Gauge, Network } from 'lucide-react';
import ConfigurationSection from './ConfigurationSection';
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
    <div className="hub-config-fields grid grid-cols-1 gap-4 sm:grid-cols-3">
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
        <ConfigurationSection title={t('serviceControls.rateTitle')} icon={Gauge}>
          <p className="hub-config-description">{t('serviceControls.description')}</p>
          <label className="hub-config-toggle">
            <span>{t('serviceControls.enabled')}</span>
            <input
              className="hub-config-checkbox"
              type="checkbox"
              checked={policy.enabled}
              onChange={(e) => onChange({ rateLimit: { ...policy, enabled: e.target.checked } })}
            />
          </label>
          {policy.enabled && (
            <>
              {renderFields(fields.slice(0, 3))}
              <details className="hub-config-advanced">
                <summary>{t('serviceControls.advanced')}</summary>
                {renderFields(fields.slice(3))}
              </details>
            </>
          )}
        </ConfigurationSection>
      )}

      {stdio && (
        <ConfigurationSection
          title={t('serviceControls.relayTitle')}
          icon={Network}
          badge={relaySupported ? undefined : t('serviceControls.relayUnsupportedBadge')}
        >
          {relaySupported ? (
            <>
              <p className="hub-config-description">{t('serviceControls.relayDescription')}</p>
              <label className="hub-config-toggle">
                <span>{t('serviceControls.relayEnabled')}</span>
                <input
                  type="checkbox"
                  className="hub-config-checkbox"
                  checked={relay?.enabled ?? relayDefault ?? false}
                  disabled={relayDefault === undefined && relay === undefined}
                  onChange={(e) => onChange({ relay: { ...relay, enabled: e.target.checked } })}
                />
              </label>
              <p className="hub-config-note">
                {t('serviceControls.relayCentralHint')}{' '}
                <Link className="text-[var(--hub-accent)] hover:underline" to="/relay">
                  {t('atlas.title')}
                </Link>
              </p>
              {relayDefault === false && (
                <p className="hub-config-note">{t('serviceControls.relayNotConfigured')}</p>
              )}
            </>
          ) : (
            <p className="hub-config-description">{t('serviceControls.relayUnsupported')}</p>
          )}
        </ConfigurationSection>
      )}
    </>
  );
}
