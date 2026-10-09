import { useTranslation } from 'react-i18next';
import type { TargetConnection } from '../../../src/types/targetConnection';
import ServiceControls from './ServiceControls';
import KeyPoolEditor from './KeyPoolEditor';
const recordText = (value?: Record<string, string>) =>
  Object.entries(value || {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
const parseRecord = (value: string) =>
  Object.fromEntries(
    value
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i).trim(), line.slice(i + 1)];
      }),
  );
export default function TargetConnectionEditor({
  value,
  onChange,
}: {
  value?: TargetConnection[];
  onChange: (value: TargetConnection[]) => void;
}) {
  const { t } = useTranslation();
  const targets = value || [];
  const patch = (index: number, changes: Partial<TargetConnection>) =>
    onChange(targets.map((target, i) => (i === index ? { ...target, ...changes } : target)));
  const input = 'hub-input w-full rounded border p-2';
  return (
    <details className="mb-4 rounded border border-[var(--hub-line)] p-4">
      <summary className="cursor-pointer font-medium">{t('targets.title')}</summary>
      <p className="my-3 hub-sub">{t('targets.description')}</p>
      {targets.map((target, index) => (
        <fieldset
          key={index}
          className="mb-4 space-y-3 rounded border border-[var(--hub-line)] p-4"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <label>
              {t('targets.path')}
              <input
                aria-label={`${t('targets.path')} ${index + 1}`}
                className={input}
                value={target.path}
                onChange={(e) => patch(index, { path: e.target.value })}
                placeholder="project/suite"
              />
            </label>
            <label>
              {t('targets.kind')}
              <select
                className={input}
                value={target.kind}
                onChange={(e) => patch(index, { kind: e.target.value as TargetConnection['kind'] })}
              >
                <option value="static">{t('targets.static')}</option>
                <option value="task">{t('targets.task')}</option>
              </select>
            </label>
            <label>
              {t('targets.allowedKeys')}
              <input
                className={input}
                value={target.allowedKeyIds?.join(',') || ''}
                onChange={(e) =>
                  patch(index, {
                    allowedKeyIds: e.target.value
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label>
              {t('targets.allowedUsers')}
              <input
                className={input}
                value={target.allowedUsers?.join(',') || ''}
                onChange={(e) =>
                  patch(index, {
                    allowedUsers: e.target.value
                      .split(',')
                      .map((v) => v.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          </div>
          {target.kind === 'static' && (
            <>
              <label className="block">
                {t('targets.transport')}
                <select
                  className={input}
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
                <div className="grid gap-3 md:grid-cols-2">
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
                <label className="block">
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
              <div className="grid gap-3 md:grid-cols-2">
                {(['env', 'headers'] as const).map((field) => (
                  <label key={field}>
                    {t(`targets.${field}`)}
                    <textarea
                      className={`${input} font-mono text-sm`}
                      rows={3}
                      defaultValue={recordText(target.config?.[field])}
                      onBlur={(e) =>
                        patch(index, {
                          config: { ...target.config, [field]: parseRecord(e.target.value) },
                        })
                      }
                      placeholder="NAME=value"
                    />
                  </label>
                ))}
              </div>
              <ServiceControls
                hideRateLimit
                relay={target.config?.relay}
                stdio={target.config?.type === 'stdio'}
                onChange={(changes) =>
                  patch(index, { config: { ...target.config, relay: changes.relay } })
                }
              />
              {target.config?.type === 'stdio' && (
                <KeyPoolEditor
                  value={target.config?.keyPool}
                  onChange={(keyPool) => patch(index, { config: { ...target.config, keyPool } })}
                />
              )}
            </>
          )}
          {target.kind === 'task' && (
            <ServiceControls
              hideRateLimit
              stdio
              relay={target.config?.relay}
              onChange={(changes) => patch(index, { config: { relay: changes.relay } })}
            />
          )}
          <button
            type="button"
            className="hub-btn danger"
            onClick={() => onChange(targets.filter((_, i) => i !== index))}
          >
            {t('targets.remove')}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="hub-btn"
        onClick={() =>
          onChange([...targets, { path: '', kind: 'static', config: { type: 'streamable-http' } }])
        }
      >
        {t('targets.add')}
      </button>
    </details>
  );
}
