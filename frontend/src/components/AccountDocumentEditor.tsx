import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceCredentialFile } from '../../../src/types/workspace';
import {
  documentField,
  updateDocumentField,
  validateDocument,
} from '../../../src/utils/workspaceDocuments';
import SecretInput from './SecretInput';
import AccountDocumentDefaults from './AccountDocumentDefaults';

/** Form fields and the advanced source editor always edit the same document. */
export default function AccountDocumentEditor({
  file,
  value,
  disabled,
  onChange,
}: {
  file: WorkspaceCredentialFile;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(false);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const valid = validateDocument(file, value);
  return (
    <div className="space-y-4 border-t border-[var(--hub-line)] pt-5">
      <div className="space-y-2">
        <p className="hub-label">{file.label || file.path}</p>
        {file.description && <p className="hub-config-note">{file.description}</p>}
      </div>
      {valid &&
        file.fields?.map((field) => {
          const current = documentField(file, value, field.name);
          const text = current === undefined || current === null ? '' : String(current);
          return (
            <label className="hub-field" key={field.name}>
              <span className="hub-label">
                {field.label || field.name}
                {field.label && field.label !== field.name && (
                  <span className="font-normal text-[var(--hub-ink-3)] break-all">
                    {' '}
                    ({field.name})
                  </span>
                )}
              </span>
              {field.multiline && (field.secret === false || visible[field.name]) ? (
                <textarea
                  aria-label={field.label || field.name}
                  className="hub-input min-h-28 font-mono text-sm"
                  value={text}
                  disabled={disabled}
                  onChange={(event) => {
                    try {
                      onChange(updateDocumentField(file, value, field.name, event.target.value));
                    } catch {
                      setPreview(true);
                    }
                  }}
                />
              ) : (
                <SecretInput
                  className="hub-input"
                  sensitive={field.secret !== false}
                  aria-label={field.label || field.name}
                  secretLabel={field.label || field.name}
                  value={text}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(updateDocumentField(file, value, field.name, event.target.value))
                  }
                />
              )}
              {field.multiline && field.secret !== false && (
                <button
                  type="button"
                  className="self-start text-xs text-[var(--hub-ink-2)]"
                  onClick={() => setVisible({ ...visible, [field.name]: !visible[field.name] })}
                >
                  {t(
                    visible[field.name]
                      ? 'startupAccounts.hideDocument'
                      : 'startupAccounts.showMultiline',
                  )}
                </button>
              )}
              {field.default !== undefined && (
                <span className="hub-config-note break-all">
                  {t('startupAccounts.defaultValue', { value: field.default })}
                </span>
              )}
              {field.description && <span className="hub-config-note">{field.description}</span>}
            </label>
          );
        })}
      <AccountDocumentDefaults file={file} />
      {file.format === 'text' && (
        <>
          <button
            type="button"
            className="self-start text-sm text-[var(--hub-ink-2)]"
            onClick={() => setPreview(!preview)}
          >
            {t(preview ? 'startupAccounts.hideDocument' : 'startupAccounts.showMultiline')}
          </button>
          {!preview && (
            <SecretInput
              className="hub-input"
              value={value}
              disabled={disabled}
              secretLabel={file.label || file.path}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
          {preview && (
            <textarea
              className="hub-input min-h-36 font-mono text-sm"
              value={value}
              disabled={disabled}
              aria-label={file.label || file.path}
              spellCheck={false}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
        </>
      )}
      {file.format !== 'text' && (
        <div className="space-y-3">
          <button
            type="button"
            className="text-sm text-[var(--hub-ink-2)] hover:text-[var(--hub-ink)]"
            aria-expanded={preview}
            onClick={() => setPreview(!preview)}
          >
            {t(preview ? 'startupAccounts.hideDocument' : 'startupAccounts.editDocument')}
          </button>
          {preview && (
            <>
              <p className="hub-config-note">
                {t('startupAccounts.documentWarning')} · {file.path}
              </p>
              <textarea
                className="hub-input min-h-56 font-mono text-sm"
                value={value}
                disabled={disabled}
                aria-label={t('startupAccounts.documentSource', { name: file.label || file.path })}
                spellCheck={false}
                onChange={(event) => onChange(event.target.value)}
              />
            </>
          )}
        </div>
      )}
      {!valid && (
        <p role="alert" className="text-sm text-[var(--hub-err)]">
          {t('startupAccounts.invalidJson')}
        </p>
      )}
    </div>
  );
}
