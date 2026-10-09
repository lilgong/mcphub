import SecretInput from './SecretInput';
import { keySuffix } from '../../../src/utils/keySuffix';
import { useTranslation } from 'react-i18next';
import type { KeyPoolConfig } from '../../../src/types/keyPool';
export default function KeyPoolEditor({
  value,
  onChange,
  provider,
}: {
  provider?: KeyPoolConfig['provider'];
  value?: KeyPoolConfig;
  onChange: (value: KeyPoolConfig | undefined) => void;
}) {
  const { t } = useTranslation();
  if (!provider) return null;
  const pool = value ?? {
    enabled: false,
    provider,
    keys: [],
  };
  const update = (patch: Partial<KeyPoolConfig>) => onChange({ ...pool, ...patch, provider });
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
        <p className="text-sm font-medium">{provider === 'context7' ? 'Context7' : 'TwelveData'}</p>
        {pool.enabled && <p className="hub-sub text-sm">{t('keyPool.singleIgnored')}</p>}
        {pool.keys.map((entry, index) => (
          <div key={entry.id} className="flex flex-wrap gap-2">
            <span
              className="min-w-24 self-center font-mono"
              aria-label={`${t('keyPool.label')} ${index + 1}`}
            >
              {keySuffix(entry.value)}
            </span>
            <SecretInput
              autoComplete="new-password"
              className="hub-input rounded border p-2"
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
