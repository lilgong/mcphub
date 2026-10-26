import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiGet } from '@/utils/fetchInterceptor';

export default function LogCatalogFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    void apiGet('/catalogs')
      .then((result) => {
        if (active && result.success && Array.isArray(result.data))
          setNames(result.data.map((item: { name: string }) => item.name).filter(Boolean));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return (
    <label className="hub-field">
      <span className="hub-label">{t('catalog.label')}</span>
      <select
        className="hub-input"
        aria-label={t('catalog.label')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="*">{t('catalog.all')}</option>
        <option value="">{t('catalog.public')}</option>
        {names.map((name) => (
          <option value={name} key={name}>
            {name}
          </option>
        ))}
        <option value="_legacy">{t('catalog.legacyLogs')}</option>
      </select>
    </label>
  );
}
