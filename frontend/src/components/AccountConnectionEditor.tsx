import RequestTimeoutEditor from './RequestTimeoutEditor';
import SettingHint from './SettingHint';
import type { TargetConnectionConfig } from '../../../src/types/targetConnection';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import SecretInput from './SecretInput';

/** Each account owns its launch configuration; no additional connection identifier. */
export default function AccountConnectionEditor({
  value,
  disabled,
  managedEnv = [],
  onChange,
}: {
  value: TargetConnectionConfig;
  disabled: boolean;
  managedEnv?: string[];
  onChange: (value: TargetConnectionConfig) => void;
}) {
  const { t } = useTranslation();
  const type = value.type || 'stdio';
  const variables = type === 'stdio' ? 'env' : 'headers';
  const entries = Object.entries(value[variables] ?? {}).filter(
    ([key]) => !managedEnv.includes(key),
  );
  const setEntries = (next: [string, string][]) =>
    onChange({
      ...value,
      [variables]: {
        ...Object.fromEntries(
          Object.entries(value[variables] ?? {}).filter(([key]) => managedEnv.includes(key)),
        ),
        ...Object.fromEntries(next),
      },
    });
  return (
    <div className="space-y-5">
      <label className="hub-field">
        <span className="hub-label inline-flex items-center gap-2">
          {t('server.type')}
          <SettingHint label={t('editorHints.details', { name: t('server.type') })}>
            {t('accountModes.versionHelp')}
          </SettingHint>
        </span>
        <select
          className="hub-input"
          value={type}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value as TargetConnectionConfig['type'];
            onChange(
              next === 'stdio'
                ? { ...value, type: next, url: undefined, headers: undefined }
                : { ...value, type: next, command: undefined, args: undefined, env: undefined },
            );
          }}
        >
          <option value="stdio">STDIO</option>
          <option value="sse">SSE</option>
          <option value="streamable-http">{t('server.typeStreamableHttp')}</option>
        </select>
      </label>
      {type === 'stdio' ? (
        <>
          <label className="hub-field">
            <span className="hub-label">{t('server.command')}</span>
            <input
              className="hub-input"
              value={value.command || ''}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, command: event.target.value })}
            />
          </label>
          <div className="space-y-3">
            <div className="flex justify-between items-center gap-3">
              <span className="hub-label">{t('server.arguments')}</span>
              <button
                type="button"
                className="hub-btn"
                disabled={disabled}
                onClick={() => onChange({ ...value, args: [...(value.args ?? []), ''] })}
              >
                <Plus size={14} />
                {t('accountModes.addArgument')}
              </button>
            </div>
            {(value.args ?? []).map((arg, index) => (
              <div key={index} className="flex gap-2">
                <input
                  className="hub-input min-w-0 flex-1"
                  aria-label={`${t('server.arguments')} ${index + 1}`}
                  value={arg}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      args: value.args?.map((item, i) => (i === index ? event.target.value : item)),
                    })
                  }
                />
                <button
                  type="button"
                  className="hub-btn"
                  disabled={disabled}
                  aria-label={t('accountModes.removeArgument')}
                  onClick={() =>
                    onChange({
                      ...value,
                      args: value.args?.filter((_, i) => i !== index),
                    })
                  }
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <label className="hub-field">
          <span className="hub-label">URL</span>
          <input
            className="hub-input"
            value={value.url || ''}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, url: event.target.value })}
          />
        </label>
      )}
      <div className="space-y-3">
        <div className="flex justify-between items-center gap-3">
          <span className="hub-label">
            {t(variables === 'env' ? 'server.envVars' : 'server.headers')}
          </span>
          <button
            type="button"
            className="hub-btn"
            disabled={disabled}
            onClick={() => {
              let key = 'KEY';
              let i = 1;
              while (entries.some(([name]) => name === key)) key = `KEY_${i++}`;
              setEntries([...entries, [key, '']]);
            }}
          >
            <Plus size={14} />
            {t('accountModes.addVariable')}
          </button>
        </div>
        {entries.map(([key, content], index) => (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
            <input
              className="hub-input"
              aria-label={t('workspaceCredentials.field')}
              disabled={disabled}
              value={key}
              onChange={(event) => {
                const name = event.target.value;
                if (
                  managedEnv.includes(name) ||
                  entries.some(([k], i) => i !== index && k === name)
                )
                  return;
                setEntries(entries.map((entry, i) => (i === index ? [name, content] : entry)));
              }}
            />
            <SecretInput
              className="hub-input"
              disabled={disabled}
              value={content}
              secretLabel={key}
              onChange={(event) =>
                setEntries(
                  entries.map((entry, i) => (i === index ? [key, event.target.value] : entry)),
                )
              }
            />
            <button
              className="hub-btn"
              type="button"
              disabled={disabled}
              aria-label={t('accountModes.removeVariable')}
              onClick={() => setEntries(entries.filter((_, i) => i !== index))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <RequestTimeoutEditor
        value={value.options}
        stdio={type === 'stdio'}
        disabled={disabled}
        resetDefault={false}
        onChange={(options) => onChange({ ...value, options })}
      />
    </div>
  );
}
