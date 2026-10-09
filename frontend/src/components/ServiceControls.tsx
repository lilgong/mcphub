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
  onChange,
}: {
  hideRateLimit?: boolean;
  rateLimit?: ServiceRateLimit;
  relay?: FetchRelayConfig;
  stdio: boolean;
  onChange: (value: { rateLimit?: ServiceRateLimit; relay?: FetchRelayConfig }) => void;
}) {
  const { t } = useTranslation();
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
        <ConfigurationSection title="Relay" icon={Network}>
          <p className="hub-config-description">{t('serviceControls.relayDescription')}</p>
          <div className="hub-config-fields grid gap-4 sm:grid-cols-2">
            <label>
              <span>{t('serviceControls.relay')}</span>
              <select
                aria-label={t('serviceControls.relay')}
                className="hub-input"
                value={relay == null ? 'inherit' : relay.enabled ? 'on' : 'off'}
                onChange={(e) =>
                  onChange({
                    relay:
                      e.target.value === 'inherit'
                        ? undefined
                        : {
                            enabled: e.target.value === 'on',
                            envPrefix: relay?.envPrefix ?? 'PUBMED',
                          },
                  })
                }
              >
                <option value="inherit">{t('serviceControls.inherit')}</option>
                <option value="on">{t('serviceControls.relayOn')}</option>
                <option value="off">{t('serviceControls.relayOff')}</option>
              </select>
            </label>
            {relay && (
              <label className="block text-sm">
                {t('serviceControls.envPrefix')}
                <input
                  className="hub-input"
                  value={relay.envPrefix}
                  onChange={(e) => onChange({ relay: { ...relay, envPrefix: e.target.value } })}
                />
              </label>
            )}
          </div>
        </ConfigurationSection>
      )}
    </>
  );
}
