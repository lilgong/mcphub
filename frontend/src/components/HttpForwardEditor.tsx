import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import SecretInput from './SecretInput';
import { useSettingsData } from '../hooks/useSettingsData';
import type { EnvVar } from '../types';
import {
  readHttpForwardAuth,
  suggestedHttpAuth,
  extraHttpHeaders,
  buildHttpAuthHeaders,
  type HttpForwardAuth,
  type HttpAuthMode,
} from '../utils/httpForwardAuth';

export default function HttpForwardEditor({
  name,
  url,
  headers,
  onUrlChange,
  onHeadersChange,
  timeout,
  onTimeoutChange,
}: {
  name: string;
  url: string;
  headers: EnvVar[];
  onUrlChange: (url: string) => void;
  onHeadersChange: (headers: EnvVar[]) => void;
  timeout: number;
  onTimeoutChange: (timeout: number) => void;
}) {
  const { t } = useTranslation();
  const [auth, setAuth] = useState<HttpForwardAuth>(() => readHttpForwardAuth(url, headers));
  const [manualMode, setManualMode] = useState(false);
  const extraHeaders = extraHttpHeaders(headers, auth);
  const updateAuth = (next: HttpForwardAuth) => {
    onHeadersChange(buildHttpAuthHeaders(next, extraHeaders));
    setAuth(next);
  };
  const changeUrl = (value: string) => {
    onUrlChange(value);
    const suggestion = suggestedHttpAuth(value);
    if (!manualMode && suggestion && suggestion !== auth.mode) {
      updateAuth({
        ...auth,
        mode: suggestion,
        headerName: suggestion === 'header' ? 'X-API-KEY' : 'Authorization',
      });
    }
  };
  const changeExtraHeaders = (extra: EnvVar[]) =>
    onHeadersChange(buildHttpAuthHeaders(auth, extra));
  const { installConfig } = useSettingsData();
  const baseUrl = installConfig?.baseUrl?.replace(/\/+$/, '') || '';
  const endpoint = `${baseUrl}/http/${encodeURIComponent(name.trim() || 'serper')}`;
  return (
    <div className="space-y-5">
      <p className="hub-sub text-sm leading-relaxed">{t('server.httpForward.help')}</p>
      <label className="block text-sm font-medium text-[var(--hub-ink)]">
        {t('server.httpForward.upstream')}
        <input
          className="hub-input mt-2"
          type="text"
          value={url}
          required
          placeholder="https://yibuapi.com/serper"
          onChange={(event) => changeUrl(event.target.value)}
        />
      </label>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <label className="block text-sm font-medium text-[var(--hub-ink)]">
          {t('server.httpForward.authMode')}
          <select
            className="hub-input mt-2"
            value={auth.mode}
            onChange={(event) => {
              setManualMode(true);
              const mode = event.target.value as HttpAuthMode;
              updateAuth({
                ...auth,
                mode,
                headerName: mode === 'header' ? 'X-API-KEY' : 'Authorization',
              });
            }}
          >
            <option value="bearer">{t('server.httpForward.bearer')}</option>
            <option value="header">{t('server.httpForward.apiKeyHeader')}</option>
            <option value="none">{t('server.httpForward.noAuth')}</option>
          </select>
        </label>
        {auth.mode !== 'none' && (
          <label className="block text-sm font-medium text-[var(--hub-ink)]">
            {t('server.httpForward.apiKey')}
            <SecretInput
              className="hub-input mt-2"
              sensitive
              secretLabel={t('server.httpForward.apiKey')}
              autoComplete="off"
              value={auth.key}
              placeholder={t('server.httpForward.keyPlaceholder')}
              onChange={(event) => updateAuth({ ...auth, key: event.target.value })}
            />
          </label>
        )}
      </div>
      {auth.mode === 'header' && (
        <label className="block text-sm font-medium text-[var(--hub-ink)]">
          {t('server.httpForward.headerName')}
          <input
            className="hub-input mt-2"
            value={auth.headerName}
            placeholder="X-API-KEY"
            required
            pattern="[!#$%&'*+.^_`|~0-9A-Za-z-]+"
            onChange={(event) => updateAuth({ ...auth, headerName: event.target.value })}
          />
        </label>
      )}
      <p className="hub-sub text-xs leading-relaxed">
        {t(
          auth.mode === 'bearer'
            ? 'server.httpForward.bearerHint'
            : 'server.httpForward.clientKeyHint',
        )}
      </p>
      <details className="rounded-lg border border-[var(--hub-line)] p-4">
        <summary className="cursor-pointer text-sm font-medium text-[var(--hub-ink-2)]">
          {t('server.httpForward.extraHeaders')}
        </summary>
        <div className="mt-4 space-y-3">
          {extraHeaders.map((header, index) => (
            <div key={index} className="flex items-center gap-3">
              <input
                className="hub-input min-w-0 flex-1"
                aria-label={t('server.httpForward.headerName')}
                value={header.key}
                placeholder="Accept"
                onChange={(event) =>
                  changeExtraHeaders(
                    extraHeaders.map((entry, i) =>
                      i === index ? { ...entry, key: event.target.value } : entry,
                    ),
                  )
                }
              />
              <SecretInput
                className="hub-input min-w-0"
                sensitive
                secretLabel={header.key}
                value={header.value}
                onChange={(event) =>
                  changeExtraHeaders(
                    extraHeaders.map((entry, i) =>
                      i === index ? { ...entry, value: event.target.value } : entry,
                    ),
                  )
                }
              />
              <button
                className="hub-btn shrink-0"
                type="button"
                aria-label={t('common.delete')}
                onClick={() => changeExtraHeaders(extraHeaders.filter((_, i) => i !== index))}
              >
                −
              </button>
            </div>
          ))}
          <button
            type="button"
            className="hub-btn text-sm"
            onClick={() => changeExtraHeaders([...extraHeaders, { key: '', value: '' }])}
          >
            {t('common.add')}
          </button>
        </div>
      </details>
      <label className="block text-sm font-medium text-[var(--hub-ink)]">
        {t('server.httpForward.timeout')}
        <input
          className="hub-input mt-2"
          type="number"
          min="1"
          max="2147483"
          value={timeout / 1000}
          onChange={(event) => onTimeoutChange(Math.max(1, Number(event.target.value)) * 1000)}
        />
      </label>
      <div className="rounded-lg border border-[var(--hub-line)] bg-[var(--hub-bg)] p-4 space-y-2">
        <p className="text-sm font-medium text-[var(--hub-ink)]">
          {t('server.httpForward.endpoint')}
        </p>
        <code className="block text-xs break-all text-[var(--hub-ink-2)] select-all">
          {endpoint}
        </code>
        <p className="hub-sub text-xs leading-relaxed">{t('server.httpForward.endpointHint')}</p>
      </div>
    </div>
  );
}
