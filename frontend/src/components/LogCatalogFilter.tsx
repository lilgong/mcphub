import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiGet } from '@/utils/fetchInterceptor';

export default function LogCatalogFilter({
  value,
  onChange,
  refresh = 0,
}: {
  value: string;
  onChange: (value: string) => void;
  refresh?: number;
}) {
  const { t } = useTranslation();
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    const load = (path: string) =>
      apiGet(path)
        .then((result) => {
          if (active && result.success && Array.isArray(result.data)) {
            const discovered = result.data
              .map((item: { name: string }) => item.name)
              .filter(Boolean);
            setNames((previous) => [...new Set<string>([...previous, ...discovered])].sort());
          }
        })
        .catch(() => undefined);
    // Current registrations are usable immediately while historical discovery runs separately.
    void Promise.allSettled([load('/catalogs'), load('/logs/catalogs')]);
    return () => {
      active = false;
    };
  }, [refresh]);
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
        <option value="_unassigned">{t('catalog.unassignedLogs')}</option>
      </select>
    </label>
  );
}
