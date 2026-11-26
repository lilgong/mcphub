import { useEffect, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../contexts/ToastContext';
import { apiGet } from '../utils/fetchInterceptor';
import { copyText } from '../utils/clipboard';
import SecretInput from './SecretInput';

/** Fetch a single managed key only while its detail dialog is open. */
export default function BearerKeySecret({ id }: { id: string }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [token, setToken] = useState('');
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setToken('');
    setFailed(false);
    setCopied(false);
    void apiGet<{ success: boolean; data?: { token: string } }>(
      `/auth/keys/${encodeURIComponent(id)}/token`,
      {
        cache: 'no-store',
      },
    )
      .then((result) => {
        if (!active) return;
        if (result.success && result.data?.token) setToken(result.data.token);
        else setFailed(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [id, attempt]);
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2">
      <SecretInput
        value={token}
        readOnly
        disabled={!token}
        placeholder="••••••••••••••••"
        className="hub-input hub-mono"
        secretLabel={t('userGroups.groupKey')}
        autoComplete="off"
        spellCheck={false}
      />
      {failed ? (
        <button
          type="button"
          className="hub-icon-btn shrink-0"
          title={t('userGroups.failed')}
          aria-label={t('common.refresh')}
          onClick={() => setAttempt((current) => current + 1)}
        >
          <RefreshCw size={15} />
        </button>
      ) : (
        <button
          type="button"
          className="hub-icon-btn shrink-0"
          disabled={!token}
          title={t(copied ? 'common.copied' : 'common.copy')}
          aria-label={t(copied ? 'common.copied' : 'common.copy')}
          onClick={async (event) => {
            const button = event.currentTarget;
            const success = await copyText(token);
            button.focus();
            setCopied(success);
            showToast(
              t(success ? 'common.copySuccess' : 'common.copyFailed'),
              success ? 'success' : 'error',
            );
          }}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      )}
    </div>
  );
}
