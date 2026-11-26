import { useTranslation } from 'react-i18next';
import type { TargetConnectionConfig } from '../../../src/types/targetConnection';
import SettingHint from './SettingHint';

export default function RequestTimeoutEditor({
  value,
  onChange,
  stdio = false,
  task = false,
  resetDefault = true,
  disabled = false,
}: {
  value?: TargetConnectionConfig['options'];
  onChange: (value: TargetConnectionConfig['options']) => void;
  stdio?: boolean;
  task?: boolean;
  resetDefault?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const update = (
    field: keyof NonNullable<TargetConnectionConfig['options']>,
    next: number | boolean | undefined,
  ) => onChange({ ...value, [field]: next });
  return (
    <section className="hub-setting-section">
      <div className="hub-setting-heading">
        <h4>{t('callSettings.timeout')}</h4>
        <SettingHint label={t('editorHints.details', { name: t('callSettings.timeout') })}>
          {t(task ? 'callSettings.taskTimeoutHelp' : 'callSettings.timeoutHelp')}
        </SettingHint>
      </div>
      <label className="hub-field max-w-sm">
        <span className="hub-label">
          {t(task ? 'callSettings.callbackWait' : 'callSettings.responseWait')}
        </span>
        <input
          className="hub-input"
          disabled={disabled}
          type="number"
          min={task ? 0 : 1000}
          step={1}
          value={value?.timeout ?? (task ? 150000 : 60000)}
          onChange={(event) =>
            update('timeout', event.target.value === '' ? undefined : Number(event.target.value))
          }
        />
      </label>
      <details className="hub-setting-advanced">
        <summary>{t('callSettings.requestAdvanced')}</summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {!task && (
            <label className="hub-field">
              <span className="hub-label inline-flex items-center gap-2">
                {t('callSettings.totalTimeout')}
                <SettingHint
                  label={t('editorHints.details', { name: t('callSettings.totalTimeout') })}
                >
                  {t('server.maxTotalTimeoutDescription')}
                </SettingHint>
              </span>
              <input
                className="hub-input"
                disabled={disabled}
                type="number"
                min={1000}
                step={1}
                placeholder={t('serviceControls.unset')}
                value={value?.maxTotalTimeout ?? ''}
                onChange={(event) =>
                  update(
                    'maxTotalTimeout',
                    event.target.value === '' ? undefined : Number(event.target.value),
                  )
                }
              />
            </label>
          )}
          {(stdio || task) && (
            <label className="hub-field">
              <span className="hub-label inline-flex items-center gap-2">
                {t(task ? 'callSettings.callbackBuffer' : 'server.maxBufferSize')}
                <SettingHint
                  label={t('editorHints.details', {
                    name: t(task ? 'callSettings.callbackBuffer' : 'server.maxBufferSize'),
                  })}
                >
                  {t(task ? 'callSettings.callbackBufferHelp' : 'server.maxBufferSizeDescription')}
                </SettingHint>
              </span>
              <input
                className="hub-input"
                disabled={disabled}
                type="number"
                min={1}
                step={1}
                placeholder={t(task ? 'callSettings.unlimited' : 'serviceControls.unset')}
                aria-label={t(task ? 'callSettings.callbackBuffer' : 'server.maxBufferSize')}
                value={
                  task
                    ? value?.maxBufferSize === 0
                      ? ''
                      : (value?.maxBufferSize ?? 4 * 1024 * 1024)
                    : (value?.maxBufferSize ?? '')
                }
                onChange={(event) =>
                  update(
                    'maxBufferSize',
                    event.target.value === '' ? (task ? 0 : undefined) : Number(event.target.value),
                  )
                }
              />
            </label>
          )}
          {!task && (
            <label className="hub-checkbox-label sm:col-span-2">
              <input
                type="checkbox"
                disabled={disabled}
                checked={value?.resetTimeoutOnProgress ?? resetDefault}
                onChange={(event) => update('resetTimeoutOnProgress', event.target.checked)}
              />
              {t('server.resetTimeoutOnProgress')}
              <SettingHint
                label={t('editorHints.details', { name: t('server.resetTimeoutOnProgress') })}
              >
                {t('server.resetTimeoutOnProgressDescription')}
              </SettingHint>
            </label>
          )}
        </div>
      </details>
    </section>
  );
}
