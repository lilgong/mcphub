import { useState } from 'react';
import SecretInput from './SecretInput';
import {
  supportsFetchRelay,
  isRelayEnvironmentVariable,
} from '../../../src/utils/relayCompatibility';
import { Layers, Plus } from 'lucide-react';
import ConfigurationSection from './ConfigurationSection';
import { getKeyPoolProvider, isPooledCredential } from '../../../src/utils/keyPoolCompatibility';
import { useTranslation } from 'react-i18next';
import type { TargetConnection, TargetConnectionConfig } from '../../../src/types/targetConnection';
import ServiceControls from './ServiceControls';
import KeyPoolEditor from './KeyPoolEditor';
export default function TargetConnectionEditor({
  value,
  onChange,
  currentConnection,
  currentVersion,
}: {
  value?: TargetConnection[];
  onChange: (value: TargetConnection[]) => void;
  currentConnection?: TargetConnectionConfig;
  currentVersion?: string;
}) {
  const { t } = useTranslation();
  const targets = value || [];
  const patch = (index: number, changes: Partial<TargetConnection>) =>
    onChange(targets.map((target, i) => (i === index ? { ...target, ...changes } : target)));
  const input = 'hub-input';
  return (
    <ConfigurationSection
      title={t(targets.length ? 'targets.title' : 'targets.optionalTitle')}
      icon={Layers}
      open={targets.length > 0 ? true : undefined}
    >
      <p className="hub-config-description">
        {t(targets.length ? 'targets.description' : 'targets.singleDescription')}
      </p>
      {targets.map((target, index) => (
        <fieldset key={index} className="hub-target-card space-y-4">
          <div className="hub-config-fields grid gap-4 sm:grid-cols-2">
            <label className="hub-config-toggle sm:col-span-2">
              <span>{t('targets.enabled')}</span>
              <input
                className="hub-config-checkbox"
                type="checkbox"
                checked={target.enabled !== false}
                onChange={(e) => patch(index, { enabled: e.target.checked })}
              />
            </label>
            <label>
              {t('targets.path')}
              <input
                aria-label={`${t('targets.path')} ${index + 1}`}
                className={input}
                value={target.path}
                onChange={(e) => patch(index, { path: e.target.value })}
                placeholder="atlas / atlas/official / other-benchmark"
              />
            </label>
            <label>
              {t('targets.version')}
              <input
                className={input}
                value={target.version ?? ''}
                maxLength={160}
                onChange={(e) => patch(index, { version: e.target.value })}
                placeholder="1.2.3 / git revision / image tag"
              />
            </label>
            <details className="hub-config-advanced sm:col-span-2">
              <summary>{t('targets.accessAdvanced')}</summary>
              <p className="hub-config-note">{t('targets.accessHint')}</p>
              <div className="hub-config-fields grid gap-4 sm:grid-cols-2">
                <label>
                  {t('targets.kind')}
                  <select
                    className={input}
                    value={target.kind}
                    onChange={(e) => {
                      const kind = e.target.value as TargetConnection['kind'];
                      patch(index, {
                        kind,
                        ...(kind === 'task' &&
                        (supportsFetchRelay(target.config ?? {}) ||
                          supportsFetchRelay(currentConnection ?? {}))
                          ? {
                              config: {
                                ...target.config,
                                env: { MCPHUB_RELAY_ADAPTER: 'fetch-v1' },
                              },
                            }
                          : {}),
                      });
                    }}
                  >
                    <option value="static">{t('targets.static')}</option>
                    <option value="task">{t('targets.task')}</option>
                  </select>
                </label>
                <label>
                  {t('targets.allowedKeys')}
                  <textarea
                    className={input}
                    value={target.allowedKeyIds?.join('\n') || ''}
                    onChange={(e) =>
                      patch(index, {
                        allowedKeyIds: e.target.value
                          .split('\n')
                          .map((v) => v.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                <label>
                  {t('targets.allowedUsers')}
                  <textarea
                    className={input}
                    value={target.allowedUsers?.join('\n') || ''}
                    onChange={(e) =>
                      patch(index, {
                        allowedUsers: e.target.value
                          .split('\n')
                          .map((v) => v.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
              </div>
            </details>
          </div>
          {target.kind === 'static' && (
            <>
              <details className="hub-config-advanced">
                <summary>{t('targets.connectionAdvanced')}</summary>
                <p className="hub-config-note">{t('targets.connectionHint')}</p>
                <label className="block text-xs text-[var(--hub-ink-2)]">
                  {t('targets.transport')}
                  <select
                    className={`${input} mt-1.5`}
                    value={target.config?.type || 'streamable-http'}
                    onChange={(e) =>
                      patch(index, {
                        config: {
                          ...target.config,
                          type: e.target.value as 'stdio' | 'streamable-http' | 'sse',
                        },
                      })
                    }
                  >
                    <option value="streamable-http">HTTP MCP</option>
                    <option value="sse">SSE MCP</option>
                    <option value="stdio">stdio MCP</option>
                  </select>
                </label>
                {target.config?.type === 'stdio' ? (
                  <div className="hub-config-fields grid gap-4 sm:grid-cols-2">
                    <label>
                      {t('targets.command')}
                      <input
                        className={input}
                        value={target.config.command || ''}
                        onChange={(e) =>
                          patch(index, { config: { ...target.config, command: e.target.value } })
                        }
                      />
                    </label>
                    <label>
                      {t('targets.args')}
                      <textarea
                        className={input}
                        value={target.config.args?.join('\n') || ''}
                        onChange={(e) =>
                          patch(index, {
                            config: { ...target.config, args: e.target.value.split('\n') },
                          })
                        }
                      />
                    </label>
                  </div>
                ) : (
                  <label className="block text-xs text-[var(--hub-ink-2)]">
                    URL
                    <input
                      className={input}
                      value={target.config?.url || ''}
                      onChange={(e) =>
                        patch(index, { config: { ...target.config, url: e.target.value } })
                      }
                    />
                  </label>
                )}
              </details>
              {target.config?.type === 'stdio' && (
                <KeyPoolEditor
                  provider={getKeyPoolProvider(target.config ?? {})}
                  value={target.config?.keyPool}
                  onChange={(keyPool) => patch(index, { config: { ...target.config, keyPool } })}
                />
              )}
              <div className="hub-config-fields grid gap-4 sm:grid-cols-2">
                {(target.config?.type === 'stdio'
                  ? (['env'] as const)
                  : (['headers'] as const)
                ).map((field) => (
                  <label key={field} className="sm:col-span-2">
                    {t(`targets.${field}`)}
                    <p className="hub-sub text-xs">
                      {t(field === 'env' ? 'server.connectionEnvHint' : 'targets.headersHint')}
                    </p>
                    <ConnectionVariables
                      key={`${field}-${index}-${target.path}`}
                      value={Object.fromEntries(
                        Object.entries(target.config?.[field] ?? {}).filter(
                          ([key]) =>
                            !(
                              supportsFetchRelay(target.config ?? {}) &&
                              isRelayEnvironmentVariable(key)
                            ) &&
                            !(
                              target.config?.keyPool?.enabled &&
                              isPooledCredential(key, getKeyPoolProvider(target.config ?? {}))
                            ),
                        ),
                      )}
                      onChange={(visible) =>
                        patch(index, {
                          config: {
                            ...target.config,
                            [field]: {
                              ...Object.fromEntries(
                                Object.entries(target.config?.[field] ?? {}).filter(
                                  ([key]) =>
                                    (supportsFetchRelay(target.config ?? {}) &&
                                      isRelayEnvironmentVariable(key)) ||
                                    (target.config?.keyPool?.enabled &&
                                      isPooledCredential(
                                        key,
                                        getKeyPoolProvider(target.config ?? {}),
                                      )),
                                ),
                              ),
                              ...visible,
                            },
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <ServiceControls
                hideRateLimit
                relay={target.config?.relay}
                stdio={target.config?.type === 'stdio'}
                relaySupported={supportsFetchRelay(target.config ?? {})}
                onChange={(changes) =>
                  patch(index, { config: { ...target.config, relay: changes.relay } })
                }
              />
            </>
          )}
          {target.kind === 'task' && (
            <ServiceControls
              hideRateLimit
              stdio
              relaySupported={
                supportsFetchRelay(target.config ?? {}) ||
                supportsFetchRelay(currentConnection ?? {})
              }
              relay={target.config?.relay}
              onChange={(changes) =>
                patch(index, { config: { ...target.config, relay: changes.relay } })
              }
            />
          )}
          <p className="hub-config-note">{t('targets.versionHint')}</p>
          <button
            type="button"
            className="hub-btn mr-2 mb-2"
            onClick={() => {
              let suffix = 1;
              let path: string;
              do {
                path = `${target.path.slice(0, 145)}-copy-${suffix++}`;
              } while (targets.some((item) => item.path === path));
              onChange([...targets, { ...structuredClone(target), path, enabled: false }]);
            }}
          >
            {t('targets.duplicate')}
          </button>
          <button
            type="button"
            className="hub-btn danger mb-2"
            onClick={() => onChange(targets.filter((_, i) => i !== index))}
          >
            {t('targets.remove')}
          </button>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="hub-btn"
          onClick={() =>
            onChange([
              ...targets,
              {
                path: '',
                kind: 'static',
                enabled: true,
                config: structuredClone(
                  targets[0]?.config ?? currentConnection ?? { type: 'streamable-http' },
                ),
              },
            ])
          }
        >
          <Plus size={14} aria-hidden />
          {t('targets.add')}
        </button>
        {currentConnection && !targets.length && (
          <button
            type="button"
            className="hub-btn"
            onClick={() =>
              onChange([
                {
                  path: '',
                  kind: 'static',
                  version: currentVersion,
                  enabled: true,
                  config: structuredClone(currentConnection),
                },
              ])
            }
          >
            {t('targets.fromCurrent')}
          </button>
        )}
      </div>
    </ConfigurationSection>
  );
}

function ConnectionVariables({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<string[][]>(() => Object.entries(value));
  const update = (next: string[][]) => {
    setRows(next);
    onChange(
      Object.fromEntries(next.filter(([key]) => key.trim()).map(([key, val]) => [key.trim(), val])),
    );
  };
  return (
    <div className="space-y-2">
      {rows.map(([key, val], index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            className="hub-input min-w-0 !w-1/2"
            aria-label={`${t('targets.variableName')} ${index + 1}`}
            value={key}
            placeholder="NAME"
            onChange={(e) =>
              update(rows.map((row, i) => (i === index ? [e.target.value, val] : row)))
            }
          />
          <SecretInput
            className="hub-input"
            sensitive={/(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)$/i.test(key)}
            secretLabel={key}
            aria-label={`${t('targets.variableValue')} ${index + 1}`}
            value={val}
            autoComplete="off"
            onChange={(e) =>
              update(rows.map((row, i) => (i === index ? [key, e.target.value] : row)))
            }
          />
          <button
            type="button"
            className="hub-btn danger"
            aria-label={`${t('targets.removeVariable')} ${index + 1}`}
            onClick={() => update(rows.filter((_, i) => i !== index))}
          >
            −
          </button>
        </div>
      ))}
      <button type="button" className="hub-btn" onClick={() => update([...rows, ['', '']])}>
        {t('targets.addVariable')}
      </button>
    </div>
  );
}
