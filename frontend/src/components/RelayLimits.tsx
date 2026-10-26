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
      setMessage(save ? t('uiLayout.limitsSaved') : '');
    } catch {
      setMessage(t('relayLimits.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4">
      <h2 className="hub-editor-heading">{t('uiLayout.upstreamLimits')}</h2>
      <p className="text-sm text-[var(--hub-ink-2)]">{t('uiLayout.upstreamScope')}</p>
      <button type="button" disabled={busy} className="hub-btn" onClick={() => request(false)}>
        {t('relayLimits.load')}
      </button>
      {limits && (
        <>
          <div className="overflow-x-auto">
            <table className="hub-relay-table">
              <thead>
                <tr>
                  <th>{t('uiLayout.upstreamCategory')}</th>
                  <th>{t('serviceControls.minIntervalMs')}</th>
                  <th>{t('serviceControls.concurrency')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(limits).map(([name, value]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>
                      <input
                        aria-label={`${name} ${t('serviceControls.minIntervalMs')}`}
                        className="hub-input"
                        type="number"
                        min="0"
                        max="600000"
                        value={value.minIntervalMs}
                        onChange={(event) =>
                          setLimits({
                            ...limits,
                            [name]: { ...value, minIntervalMs: Number(event.target.value) },
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${name} ${t('serviceControls.concurrency')}`}
                        className="hub-input"
                        type="number"
                        min="1"
                        max="1000"
                        placeholder={t('serviceControls.unset')}
                        value={value.concurrency ?? ''}
                        onChange={(event) =>
                          setLimits({
                            ...limits,
                            [name]: {
                              ...value,
                              concurrency: event.target.value
                                ? Number(event.target.value)
                                : undefined,
                            },
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" disabled={busy} className="hub-btn" onClick={() => request(true)}>
            {t('relayLimits.save')}
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
