import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiGet, apiPut } from '../utils/fetchInterceptor';
type Limits = Record<string, { minIntervalMs: number; concurrency?: number }>;
export default function RelayLimits() {
  const { t } = useTranslation();
  const [limits, setLimits] = useState<Limits>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const request = async (save: boolean) => {
    setBusy(true);
    try {
      const result = save
        ? await apiPut<{ success: boolean; data: { limits: Limits } }>('/relay/limits', { limits })
        : await apiGet<{ success: boolean; data: { limits: Limits } }>('/relay/limits');
      if (!result.success) throw new Error();
      setLimits(result.data.limits);
      setMessage(save ? t('atlas.saved') : '');
    } catch {
      setMessage(t('relayLimits.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="hub-card space-y-4 p-5">
      <h2 className="hub-card-title">{t('relayLimits.title')}</h2>
      <p className="text-sm text-[var(--hub-ink-2)]">{t('relayLimits.description')}</p>
      <button type="button" disabled={busy} className="hub-btn" onClick={() => request(false)}>
        {t('relayLimits.load')}
      </button>
      {limits && (
        <>
          {Object.entries(limits).map(([name, value]) => (
            <div
              key={name}
              className="grid grid-cols-1 items-end gap-3 border-t border-[var(--hub-line-2)] pt-4 sm:grid-cols-3"
            >
              <code className="text-xs text-[var(--hub-ink-2)] sm:self-center">{name}</code>
              <label className="hub-field">
                <span className="hub-label">{t('serviceControls.minIntervalMs')}</span>
                <input
                  aria-label={`${name} ${t('serviceControls.minIntervalMs')}`}
                  className="hub-input"
                  type="number"
                  min="0"
                  max="600000"
                  value={value.minIntervalMs}
                  onChange={(e) =>
                    setLimits({
                      ...limits,
                      [name]: { ...value, minIntervalMs: Number(e.target.value) },
                    })
                  }
                />
              </label>
              <label className="hub-field">
                <span className="hub-label">{t('serviceControls.concurrency')}</span>
                <input
                  aria-label={`${name} ${t('serviceControls.concurrency')}`}
                  className="hub-input"
                  type="number"
                  min="1"
                  max="1000"
                  placeholder={t('serviceControls.unset')}
                  value={value.concurrency ?? ''}
                  onChange={(e) =>
                    setLimits({
                      ...limits,
                      [name]: {
                        ...value,
                        concurrency: e.target.value ? Number(e.target.value) : undefined,
                      },
                    })
                  }
                />
              </label>
            </div>
          ))}
          <button type="button" disabled={busy} className="hub-btn" onClick={() => request(true)}>
            {t('relayLimits.save')}
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
