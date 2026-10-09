import { KeyRound, Plus, Trash2 } from 'lucide-react';
import ConfigurationSection from './ConfigurationSection';
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
    <ConfigurationSection
      title={t('keyPool.title')}
      icon={KeyRound}
      badge={provider === 'context7' ? 'Context7' : 'TwelveData'}
    >
      <div className="space-y-4">
        <p className="hub-config-description">{t('keyPool.description')}</p>
        <label className="hub-config-toggle">
          <span>{t('keyPool.enabled')}</span>
          <input
            type="checkbox"
            checked={pool.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            className="hub-config-checkbox"
          />
        </label>
        {pool.enabled && <p className="hub-config-note">{t('keyPool.singleIgnored')}</p>}
        {pool.keys.map((entry, index) => (
          <div key={entry.id} className="hub-key-row">
            <span
              className="hub-key-suffix hub-mono"
              aria-label={`${t('keyPool.label')} ${index + 1}`}
            >
              {keySuffix(entry.value)}
            </span>
            <SecretInput
              autoComplete="new-password"
              className="hub-input mono"
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
              className="hub-icon-btn"
              aria-label={`${t('keyPool.remove')} Key ${index + 1}`}
              title={t('keyPool.remove')}
              onClick={() => update({ keys: pool.keys.filter((key) => key.id !== entry.id) })}
            >
              <Trash2 size={15} aria-hidden />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="hub-btn"
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
          <Plus size={14} aria-hidden />
          {t('keyPool.add')}
        </button>
        <p className="hub-config-note">{t('keyPool.recovery')}</p>
      </div>
    </ConfigurationSection>
  );
}
