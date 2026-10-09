import { useTranslation } from 'react-i18next';
import type { ServerRuntimeSummary } from '../../../src/types/serverRuntime';
import { StatusDot } from './ui/StatusDot';

export default function ServerRuntimeInventory({ runtime }: { runtime: ServerRuntimeSummary }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('runtime.title')} className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">{t('runtime.title')}</span>
        <span className="hub-tag">{t('runtime.running', { count: runtime.running })}</span>
        {!!runtime.starting && (
          <span className="hub-tag">{t('runtime.starting', { count: runtime.starting })}</span>
        )}
      </div>
      <p className="text-xs hub-sub">{t('runtime.description')}</p>
      {!!runtime.targets.length && (
        <div className="flex flex-wrap gap-2">
          {runtime.targets.map((target) => (
            <span
              key={target.path}
              className="hub-tag inline-flex flex-wrap items-center gap-1.5 text-xs"
            >
              <code>{target.path}</code>
              <span>· {t(`targets.${target.implementation ?? 'unspecified'}`)}</span>
              {target.configuredVersion && <span>· {target.configuredVersion}</span>}
              <StatusDot
                kind={
                  !target.enabled
                    ? 'muted'
                    : target.running
                      ? 'ok'
                      : target.starting
                        ? 'warn'
                        : 'muted'
                }
                label={
                  !target.enabled
                    ? t('runtime.disabled')
                    : target.running
                      ? t('runtime.running', { count: target.running })
                      : target.starting
                        ? t('runtime.starting', { count: target.starting })
                        : t('runtime.idle')
                }
              />
            </span>
          ))}
        </div>
      )}
      {runtime.instances.length ? (
        <div className="overflow-x-auto rounded-lg border border-[var(--hub-line)]">
          <table className="w-full text-left text-xs">
            <thead className="hub-sub bg-[var(--hub-bg)]">
              <tr>
                {[
                  'target',
                  'kind',
                  'implementation',
                  'configuredVersion',
                  'reportedVersion',
                  'status',
                  'activity',
                ].map((field) => (
                  <th key={field} className="px-3 py-2 font-medium">
                    {t(`runtime.${field}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runtime.instances.map((instance) => (
                <tr key={instance.id} className="border-t border-[var(--hub-line)]">
                  <td className="px-3 py-2">
                    <code>{instance.target ?? t('runtime.defaultTarget')}</code>
                    {instance.taskId && (
                      <div className="mt-1 max-w-64 break-all hub-sub">{instance.taskId}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {t(
                      `runtime.${instance.kind === 'target' ? 'targetConnection' : instance.kind}`,
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {t(`targets.${instance.implementation ?? 'unspecified'}`)}
                  </td>
                  <td className="px-3 py-2 font-mono">{instance.configuredVersion ?? '—'}</td>
                  <td className="px-3 py-2 font-mono">
                    {instance.reportedVersion ?? '—'}
                    {instance.packageVersion && (
                      <div className="mt-1 hub-sub">
                        {t('runtime.packageVersion')}: {instance.packageVersion}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <StatusDot
                      kind={
                        instance.status === 'connected' || instance.status === 'registered'
                          ? 'ok'
                          : instance.status === 'connecting'
                            ? 'warn'
                            : 'err'
                      }
                      label={t(`runtime.${instance.status}`)}
                    />
                    {instance.draining && (
                      <div className="mt-1 hub-sub">{t('runtime.draining')}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap hub-sub">
                    {instance.activeCalls !== undefined && (
                      <div>{t('runtime.activeCalls', { count: instance.activeCalls })}</div>
                    )}
                    {instance.startedAt && (
                      <div>
                        {t('runtime.since')}: {new Date(instance.startedAt).toLocaleString()}
                      </div>
                    )}
                    {instance.expiresAt && (
                      <div>
                        {t('runtime.expires')}: {new Date(instance.expiresAt).toLocaleTimeString()}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs hub-sub">{t('runtime.empty')}</p>
      )}
    </section>
  );
}
