import type { WorkspaceCredentialSchema } from '../../../src/types/workspace';
import { DEFAULT_TASK_TARGET } from '../../../src/utils/taskTarget';
import { useState, type ReactNode } from 'react';
import SecretInput from './SecretInput';
import {
  supportsFetchRelay,
  isRelayEnvironmentVariable,
} from '../../../src/utils/relayCompatibility';
import { Plus, X, ChevronDown, Copy, Trash2 } from 'lucide-react';
import { getKeyPoolProvider, isPooledCredential } from '../../../src/utils/keyPoolCompatibility';
import { useTranslation } from 'react-i18next';
import type { TargetConnection, TargetConnectionConfig } from '../../../src/types/targetConnection';
import ServiceControls from './ServiceControls';
import KeyPoolEditor from './KeyPoolEditor';
export default function TargetConnectionEditor({
  value,
  onChange,
  currentConnection,
  catalog = '',
  managedStartupAccount = false,
  taskAccountEditor,
  managedFields,
  startupAccountEnabled = false,
  onStartupAccountChange,
  onUseSingle,
}: {
  value?: TargetConnection[];
  onChange: (value: TargetConnection[]) => void;
  currentConnection?: TargetConnectionConfig;
  catalog?: string;
  managedStartupAccount?: boolean;
  taskAccountEditor?: ReactNode;
  managedFields?: WorkspaceCredentialSchema['managed'];
  startupAccountEnabled?: boolean;
  onStartupAccountChange?: (enabled: boolean) => void;
  onUseSingle?: (connection?: TargetConnectionConfig) => void;
}) {
  const { t } = useTranslation();
  const targets = value || [];
  const taskOnly =
    targets.length === 1 && targets[0].path === DEFAULT_TASK_TARGET && targets[0].kind === 'task';
  const [expanded, setExpanded] = useState<number | null>(value?.length === 1 ? 0 : null);
  const [previousTask, setPreviousTask] = useState<TargetConnection[] | undefined>();
  const [previousTargets, setPreviousTargets] = useState<TargetConnection[]>([]);
  const patch = (index: number, changes: Partial<TargetConnection>) =>
    onChange(targets.map((target, i) => (i === index ? { ...target, ...changes } : target)));
  const input = 'hub-input';
  return (
    <section className="hub-editor-section">
      <h3 className="hub-editor-heading">{t('uiLayout.connection')}</h3>
      <div className="hub-mode-tabs" role="group" aria-label={t('targets.mode')}>
        {(['single', 'accounts', 'task'] as const).map((mode) => {
          const active = mode === (taskOnly ? 'task' : targets.length ? 'accounts' : 'single');
          return (
            <button
              key={mode}
              type="button"
              className={`hub-mode-tab ${active ? 'is-active' : ''}`}
              aria-pressed={active}
              onClick={() => {
                if (active) return;
                setExpanded(0);
                if (taskOnly) setPreviousTask(targets);
                if (targets.length && !taskOnly) setPreviousTargets(targets);
                if (mode === 'single') {
                  onUseSingle?.(
                    currentConnection ?? targets.find((target) => target.kind === 'static')?.config,
                  );
                  onChange([]);
                }
                if (mode === 'accounts')
                  onChange(
                    previousTargets.length
                      ? previousTargets
                      : [
                          {
                            path: `${catalog || 'workspace'}/official`,
                            kind: 'static',
                            enabled: true,
                            config: structuredClone(
                              currentConnection ?? targets[0]?.config ?? { type: 'stdio' },
                            ),
                          },
                        ],
                  );
                if (mode === 'task')
                  onChange(
                    previousTask ?? [
                      {
                        path: DEFAULT_TASK_TARGET,
                        kind: 'task',
                        enabled: true,
                        config: structuredClone(targets[0]?.config ?? currentConnection ?? {}),
                        startupEnvKeys: targets[0]?.startupEnvKeys ?? [],
                      },
                    ],
                  );
              }}
            >
              {t(`uiLayout.mode_${mode}`)}
            </button>
          );
        })}
      </div>
      <p className="hub-config-description">
        {t(`uiLayout.help_${taskOnly ? 'task' : targets.length ? 'accounts' : 'single'}`)}
      </p>
      <div className={taskOnly ? '' : 'hub-account-list'}>
        {targets.map((target, index) => (
          <fieldset
            key={index}
            className={taskOnly ? 'hub-task-config' : 'hub-account-item'}
            onInvalidCapture={() => setExpanded(index)}
          >
            {!taskOnly && (
              <button
                type="button"
                className={`hub-account-row ${expanded === index ? 'is-active' : ''}`}
                aria-expanded={expanded === index}
                aria-controls={`target-connection-${index}`}
                onClick={() => setExpanded(expanded === index ? null : index)}
              >
                <span className="hub-account-identity">
                  <span className="hub-account-name">
                    {target.path.split('/').slice(-1)[0] || t('uiLayout.newWorkspace')}
                  </span>
                  {target.path && <span className="hub-account-caption">{target.path}</span>}
                </span>
                <span className="hub-account-meta">
                  {t(
                    target.enabled === false
                      ? 'uiLayout.accountDisabled'
                      : 'uiLayout.accountEnabled',
                  )}
                </span>
                <ChevronDown
                  size={16}
                  aria-hidden
                  className={expanded === index ? '' : '-rotate-90'}
                />
              </button>
            )}
            <div
              id={`target-connection-${index}`}
              hidden={!taskOnly && expanded !== index}
              className={taskOnly ? 'space-y-5' : 'hub-account-body space-y-5'}
            >
              <div className="hub-config-fields grid gap-4 sm:grid-cols-2">
                <label className="hub-config-toggle sm:col-span-2">
                  <span>{t(taskOnly ? 'uiLayout.taskEnabled' : 'targets.enabled')}</span>
                  <input
                    className="hub-config-checkbox"
                    type="checkbox"
                    checked={target.enabled !== false}
                    onChange={(e) => patch(index, { enabled: e.target.checked })}
                  />
                </label>
                {!taskOnly && (
                  <label className="sm:col-span-2">
                    {t('uiLayout.workspaceName')}
                    <input
                      className={input}
                      aria-label={`${t('uiLayout.workspaceName')} ${index + 1}`}
                      value={target.path.split('/').slice(-1)[0] || ''}
                      required
                      pattern="[A-Za-z0-9_-]+"
                      onChange={(event) => {
                        const prefix = target.path.includes('/')
                          ? target.path.slice(0, target.path.lastIndexOf('/'))
                          : catalog || 'workspace';
                        patch(index, { path: `${prefix}/${event.target.value}` });
                      }}
                    />
                    <span className="hub-config-note">
                      {t('uiLayout.routeSelector')}: {target.path}
                    </span>
                  </label>
                )}
              </div>
              <label className="hub-field">
                <span className="hub-label">{t('targets.version')}</span>
                <input
                  className="hub-input"
                  aria-label={`${t('targets.version')} ${index + 1}`}
                  value={target.version || ''}
                  onChange={(event) => patch(index, { version: event.target.value || undefined })}
                />
                <span className="hub-sub text-xs">{t('targets.versionHint')}</span>
              </label>
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
                              patch(index, {
                                config: { ...target.config, command: e.target.value },
                              })
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
                                aria-label={t('server.removeArgument', {
                                  index: argumentIndex + 1,
                                })}
                                onClick={() =>
                                  patch(index, {
                                    config: {
                                      ...target.config,
                                      args: target.config?.args?.filter(
                                        (_, i) => i !== argumentIndex,
                                      ),
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
                      onChange={(keyPool) =>
                        patch(index, { config: { ...target.config, keyPool } })
                      }
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
              {taskOnly && target.kind === 'task' && taskAccountEditor && (
                <div className="border-t border-[var(--hub-line)] pt-4 space-y-4">
                  <label className="hub-checkbox-label">
                    <input
                      type="checkbox"
                      checked={startupAccountEnabled}
                      onChange={(event) => onStartupAccountChange?.(event.target.checked)}
                    />
                    <span>{t('startupAccounts.enable')}</span>
                  </label>
                  <p className="hub-config-note">{t('startupAccounts.optional')}</p>
                  {startupAccountEnabled && taskAccountEditor}
                </div>
              )}
              {taskOnly && !!managedFields?.length && (
                <div className="space-y-3 border-t border-[var(--hub-line)] pt-4">
                  <h4 className="hub-label">{t('startupAccounts.managedTitle')}</h4>
                  <dl className="space-y-4">
                    {managedFields.map((field) => (
                      <div key={field.name} className="space-y-1">
                        <dt className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                          <span className="break-all text-[var(--hub-ink-2)]">{field.name}</span>
                          <span className="text-xs text-[var(--hub-ink-3)]">
                            {t(`startupAccounts.source_${field.source}`)}
                          </span>
                        </dt>
                        {field.default !== undefined && (
                          <dd className="hub-config-note break-all">
                            {t('startupAccounts.defaultValue', { value: field.default })}
                          </dd>
                        )}
                        <dd className="hub-config-note">{field.description}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              {target.kind === 'task' && (
                <>
                  {!managedStartupAccount && (
                    <label className="hub-field">
                      <span className="hub-label">{t('targets.startupNames')}</span>
                      <textarea
                        className="hub-input"
                        rows={3}
                        style={{ height: 'auto', minHeight: 88 }}
                        value={(target.startupEnvKeys || []).join('\n')}
                        onChange={(event) =>
                          patch(index, {
                            startupEnvKeys: event.target.value
                              .split('\n')
                              .map((value) => value.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                  )}
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
                </>
              )}
              {target.kind === 'static' && (
                <details className="hub-config-advanced">
                  <summary>{t('server.requestOptions')}</summary>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <label className="hub-field">
                      <span className="hub-label">{t('server.timeout')} (ms)</span>
                      <input
                        className="hub-input"
                        type="number"
                        min="1000"
                        aria-label={`${t('server.timeout')} ${index + 1}`}
                        value={target.config?.options?.timeout ?? 60000}
                        onChange={(event) =>
                          patch(index, {
                            config: {
                              ...target.config,
                              options: {
                                ...target.config?.options,
                                timeout: Number(event.target.value),
                              },
                            },
                          })
                        }
                      />
                    </label>
                    <label className="hub-checkbox-label">
                      <input
                        type="checkbox"
                        checked={target.config?.options?.resetTimeoutOnProgress ?? false}
                        onChange={(event) =>
                          patch(index, {
                            config: {
                              ...target.config,
                              options: {
                                ...target.config?.options,
                                resetTimeoutOnProgress: event.target.checked,
                              },
                            },
                          })
                        }
                      />
                      {t('server.resetTimeoutOnProgress')}
                    </label>
                  </div>
                </details>
              )}
              <p className="hub-config-note">
                {t(taskOnly ? 'uiLayout.taskAccess' : 'targets.accessManagedHint')}
              </p>

              {!taskOnly && (
                <div className="hub-account-actions">
                  <button
                    type="button"
                    className="hub-btn"
                    onClick={() => {
                      let suffix = 1;
                      let path: string;
                      do {
                        path = `${target.path.slice(0, 145)}-copy-${suffix++}`;
                      } while (targets.some((item) => item.path === path));
                      setExpanded(targets.length);
                      onChange([...targets, { ...structuredClone(target), path, enabled: true }]);
                    }}
                  >
                    <Copy size={14} aria-hidden />
                    {t('uiLayout.copyAccount')}
                  </button>
                  <button
                    type="button"
                    className="hub-btn danger"
                    onClick={() => {
                      setExpanded(Math.max(0, index - 1));
                      onChange(targets.filter((_, i) => i !== index));
                    }}
                  >
                    <Trash2 size={14} aria-hidden />
                    {t('uiLayout.removeWorkspace')}
                  </button>
                </div>
              )}
            </div>
          </fieldset>
        ))}
      </div>
      {!taskOnly && targets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="hub-btn"
            onClick={() => {
              setExpanded(targets.length);
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
              ]);
            }}
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
      )}
    </section>
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
