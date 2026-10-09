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
  rateLimit,
  relay,
  stdio,
  onChange,
}: {
  rateLimit?: ServiceRateLimit;
  relay?: FetchRelayConfig;
  stdio: boolean;
  onChange: (value: { rateLimit?: ServiceRateLimit; relay?: FetchRelayConfig }) => void;
}) {
  const { t } = useTranslation();
  const policy = rateLimit ?? { enabled: false };
  return (
    <details className="mb-4 rounded border border-[var(--hub-line)] p-4">
      <summary className="cursor-pointer font-medium">{t('serviceControls.title')}</summary>
      <p className="my-3 text-sm text-[var(--hub-ink-2)]">{t('serviceControls.description')}</p>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={policy.enabled}
          onChange={(e) => onChange({ rateLimit: { ...policy, enabled: e.target.checked } })}
        />
        {t('serviceControls.enabled')}
      </label>
      {policy.enabled && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {fields.map((field) => (
            <label key={field} className="text-sm">
              {t(`serviceControls.${field}`)}
              <input
                aria-label={t(`serviceControls.${field}`)}
                className="hub-input mt-1 w-full rounded border p-2"
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
      )}
      {stdio && (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-[var(--hub-ink-2)]">{t('serviceControls.relayDescription')}</p>
          <select
            aria-label={t('serviceControls.relay')}
            className="hub-input rounded border p-2"
            value={relay == null ? 'inherit' : relay.enabled ? 'on' : 'off'}
            onChange={(e) =>
              onChange({
                relay:
                  e.target.value === 'inherit'
                    ? undefined
                    : { enabled: e.target.value === 'on', envPrefix: relay?.envPrefix ?? 'PUBMED' },
              })
            }
          >
            <option value="inherit">{t('serviceControls.inherit')}</option>
            <option value="on">{t('serviceControls.relayOn')}</option>
            <option value="off">{t('serviceControls.relayOff')}</option>
          </select>
          {relay && (
            <label className="block text-sm">
              {t('serviceControls.envPrefix')}
              <input
                className="hub-input ml-2 rounded border p-2"
                value={relay.envPrefix}
                onChange={(e) => onChange({ relay: { ...relay, envPrefix: e.target.value } })}
              />
            </label>
          )}
        </div>
      )}
    </details>
  );
}
