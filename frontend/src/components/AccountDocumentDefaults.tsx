import { useTranslation } from 'react-i18next';
import type { WorkspaceCredentialFile } from '../../../src/types/workspace';

/** Only public template defaults are shown; never enumerate saved account secrets. */
export default function AccountDocumentDefaults({ file }: { file: WorkspaceCredentialFile }) {
  const { t } = useTranslation();
  if (!file.template) return null;
  let template: Record<string, unknown>;
  try {
    template = JSON.parse(file.template) as Record<string, unknown>;
  } catch {
    return null;
  }
  const editable = new Set((file.fields || []).map((field) => field.name.split('.')[0]));
  const defaults = Object.entries(template).filter(
    ([name, value]) =>
      !editable.has(name) &&
      value !== '' &&
      value !== null &&
      !(Array.isArray(value) && value.length === 0),
  );
  if (!defaults.length) return null;
  return (
    <div className="space-y-3">
      <p className="hub-label">{t('startupAccounts.publicDefaults')}</p>
      <p className="hub-config-note">{t('startupAccounts.publicDefaultsHelp')}</p>
      <dl className="space-y-3">
        {defaults.map(([name, value]) => (
          <div key={name} className="grid gap-1">
            <dt className="text-xs text-[var(--hub-ink-2)] break-all">{name}</dt>
            <dd className="hub-config-note whitespace-pre-wrap break-all">
              {Array.isArray(value)
                ? value.join('\n')
                : typeof value === 'object'
                  ? JSON.stringify(value, null, 2)
                  : String(value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
