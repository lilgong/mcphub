import { useTranslation } from 'react-i18next';
import { splitServerKey } from '../../../src/utils/catalog';

/** Keep the logical MCP name prominent and its namespace visibly separate. */
export default function LogServerIdentity({
  server,
  catalog,
  showCatalog = true,
}: {
  server: string;
  catalog?: string;
  showCatalog?: boolean;
}) {
  const { t } = useTranslation();
  const identity = splitServerKey(server);
  const space = catalog ?? identity.catalog;
  const label =
    space === '_legacy'
      ? t('catalog.legacyLogs')
      : space === '_unassigned'
        ? t('catalog.unassignedLogs')
        : space || t('catalog.public');

  return (
    <span className="hub-log-server" title={server}>
      <span className="hub-log-server-name">{identity.name}</span>
      {showCatalog && (
        <span className="hub-log-server-space" title={`${t('catalog.label')}: ${label}`}>
          {label}
        </span>
      )}
    </span>
  );
}
