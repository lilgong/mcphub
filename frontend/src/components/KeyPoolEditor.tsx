import { useTranslation } from 'react-i18next';
import type { KeyPoolConfig } from '../../../src/types/keyPool';
export default function KeyPoolEditor({
  value,
  onChange,
  serverName,
}: {
  serverName?: string;
  value?: KeyPoolConfig;
  onChange: (value: KeyPoolConfig | undefined) => void;
}) {
  const { t } = useTranslation();
  const pool = value ?? {
    enabled: false,
    provider: serverName === 'twelvedata' ? 'twelvedata' : 'context7',
    keys: [],
  };
  const update = (patch: Partial<KeyPoolConfig>) => onChange({ ...pool, ...patch });
  return (
    <details className="rounded border p-4">
      <summary className="cursor-pointer font-medium">{t('keyPool.title')}</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-[var(--hub-ink-2)]">{t('keyPool.description')}</p>
        <label>
          <input
            type="checkbox"
            checked={pool.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />{' '}
          {t('keyPool.enabled')}
        </label>
        <label className="block">
          {t('keyPool.provider')}
          <select
            aria-label={t('keyPool.provider')}
            className="hub-input ml-3 rounded border p-2"
            value={pool.provider}
            onChange={(e) => update({ provider: e.target.value as KeyPoolConfig['provider'] })}
          >
            <option value="context7">Context7</option>
            <option value="twelvedata">TwelveData</option>
          </select>
        </label>
        {pool.keys.map((entry, index) => (
          <div key={entry.id} className="flex flex-wrap gap-2">
            <input
              className="hub-input rounded border p-2"
              aria-label={`${t('keyPool.label')} ${index + 1}`}
              value={entry.label}
              onChange={(e) =>
                update({
                  keys: pool.keys.map((key) =>
                    key.id === entry.id ? { ...key, label: e.target.value } : key,
                  ),
                })
              }
              maxLength={80}
            />
            <input
              type="password"
              autoComplete="new-password"
              className="hub-input flex-1 rounded border p-2"
              aria-label={`Key ${index + 1}`}
              value={entry.value}
              onChange={(e) =>
                update({
                  keys: pool.keys.map((key) =>
                    key.id === entry.id ? { ...key, value: e.target.value } : key,
                  ),
                })
              }
            />
            <button
              type="button"
              className="rounded border p-2"
              onClick={() => update({ keys: pool.keys.filter((key) => key.id !== entry.id) })}
            >
              {t('keyPool.remove')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="rounded border p-2"
          disabled={pool.keys.length >= 32}
          onClick={() =>
            update({
              keys: [
                ...pool.keys,
                {
                  id: `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
                  label: `key-${pool.keys.length + 1}`,
                  value: '',
                },
              ],
            })
          }
        >
          {t('keyPool.add')}
        </button>
        <p className="text-sm">{t('keyPool.recovery')}</p>
      </div>
    </details>
  );
}
