import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiGet } from '@/utils/fetchInterceptor';

interface CatalogInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  help?: string;
}

export default function CatalogInput({ value, onChange, disabled, help }: CatalogInputProps) {
  const { t } = useTranslation();
  const id = useId();
  const [names, setNames] = useState<string[]>(['atlas', 'toolathlon']);
  useEffect(() => {
    let active = true;
    apiGet('/catalogs')
      .then((result) => {
        if (active && result.success && Array.isArray(result.data)) {
          setNames([
            ...new Set<string>([
              'atlas',
              'toolathlon',
              ...result.data.map((item: { name: string }) => item.name).filter(Boolean),
            ]),
          ]);
        }
      })
      .catch(() => {
        /* Manual entry remains available if suggestions cannot be loaded. */
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="mb-4">
      <label htmlFor={id} className="block text-sm font-medium mb-2">
        {t('catalog.label')}
      </label>
      <input
        id={id}
        className="hub-input w-full"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={t('catalog.placeholder')}
        pattern="[a-z][a-z0-9_-]{0,47}"
        maxLength={48}
        list={`${id}-options`}
      />
      <datalist id={`${id}-options`}>
        {names.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <p className="hub-sub mt-1 text-xs">{help || t('catalog.importHelp')}</p>
    </div>
  );
}
