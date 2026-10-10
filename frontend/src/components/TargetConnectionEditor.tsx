import { useState } from 'react';
import SecretInput from './SecretInput';
import {
  supportsFetchRelay,
  isRelayEnvironmentVariable,
} from '../../../src/utils/relayCompatibility';
import { Layers, Plus, X } from 'lucide-react';
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
              {t('targets.application')}
              <input
                className={input}
                aria-label={`${t('targets.application')} ${index + 1}`}
                value={target.path.split('/')[0] ?? ''}
                placeholder="atlas"
                pattern="[A-Za-z0-9_-]+"
                required
                onChange={(e) =>
                  patch(index, {
                    path: `${e.target.value}/${target.path.split('/').slice(1).join('/')}`,
                  })
                }
              />
            </label>
            <label>
              {t('targets.category')}
              <input
                className={input}
                aria-label={`${t('targets.category')} ${index + 1}`}
                value={target.path.split('/').slice(1).join('/')}
                placeholder="official / syn-1 / default"
                pattern="[A-Za-z0-9_-]+"
                required
                onChange={(e) =>
                  patch(index, { path: `${target.path.split('/')[0] ?? ''}/${e.target.value}` })
                }
              />
            </label>
            <p className="hub-config-note sm:col-span-2">
              {t('targets.path')}:{' '}
              <code className="hub-mono">{target.path || 'benchmark/category'}</code>
            </p>
            <label className="sm:col-span-2">
              {t('targets.version')}
              <input
                className={input}
                aria-label={t('targets.version')}
                value={target.version ?? ''}
                maxLength={160}
                onChange={(e) => patch(index, { version: e.target.value })}
                placeholder="1.2.3 / git revision / image tag"
              />
            </label>
            <p className="hub-config-note sm:col-span-2">{t('targets.versionHint')}</p>
          </div>
          {target.kind === 'static' && (
            <>
              <div className="space-y-4">
                <label className="hub-field">
                  <span className="hub-label">{t('server.type')}</span>
                  <select
                    className={input}
                    aria-label={t('server.type')}
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
                    <option value="stdio">{t('server.typeStdio')}</option>
                    <option value="sse">{t('server.typeSse')}</option>
                    <option value="streamable-http">{t('server.typeStreamableHttp')}</option>
                  </select>
                </label>
                {target.config?.type === 'stdio' ? (
                  <>
                    <label className="hub-field">
                      <span className="hub-label">{t('server.command')}</span>
                      <input
                        className={input}
                        value={target.config.command || ''}
                        onChange={(e) =>
                          patch(index, { config: { ...target.config, command: e.target.value } })
                        }
                      />
                    </label>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="hub-label">{t('server.arguments')}</span>
                        <button
                          type="button"
                          className="hub-btn sm"
                          onClick={() =>
                            patch(index, {
                              config: {
                                ...target.config,
                                args: [...(target.config?.args ?? []), ''],
                              },
                            })
                          }
                        >
                          <Plus size={14} aria-hidden />
                          {t('server.addArgument')}
                        </button>
                      </div>
                      <p className="hub-config-note">{t('server.argumentsHint')}</p>
                      {(target.config.args ?? []).map((arg, argumentIndex) => (
                        <div key={argumentIndex} className="flex items-center gap-2">
                          <input
                            className={input}
                            aria-label={t('server.argumentLabel', { index: argumentIndex + 1 })}
                            value={arg}
                            onChange={(e) =>
                              patch(index, {
                                config: {
                                  ...target.config,
                                  args: target.config?.args?.map((value, i) =>
                                    i === argumentIndex ? e.target.value : value,
                                  ),
                                },
                              })
                            }
                          />
                          <button
                            type="button"
                            className="hub-icon-btn shrink-0"
                            aria-label={t('server.removeArgument', { index: argumentIndex + 1 })}
                            onClick={() =>
                              patch(index, {
                                config: {
                                  ...target.config,
                                  args: target.config?.args?.filter((_, i) => i !== argumentIndex),
                                },
                              })
                            }
                          >
                            <X size={16} aria-hidden />
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <label className="hub-field">
                    <span className="hub-label">URL</span>
                    <input
                      className={input}
                      value={target.config?.url || ''}
                      onChange={(e) =>
                        patch(index, { config: { ...target.config, url: e.target.value } })
                      }
                    />
                  </label>
                )}
              </div>
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
                  <div key={field} className="hub-field sm:col-span-2">
                    <span className="hub-label">
                      {t(field === 'env' ? 'server.envVars' : 'server.headers')}
                    </span>
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
                  </div>
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
          <p className="hub-config-note">{t('targets.accessManagedHint')}</p>

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
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_30px] items-center gap-2"
        >
          <input
            className="hub-input min-w-0"
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
            className="hub-icon-btn shrink-0"
            aria-label={`${t('targets.removeVariable')} ${index + 1}`}
            onClick={() => update(rows.filter((_, i) => i !== index))}
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      ))}
      <button type="button" className="hub-btn" onClick={() => update([...rows, ['', '']])}>
        {t('targets.addVariable')}
      </button>
    </div>
  );
}
