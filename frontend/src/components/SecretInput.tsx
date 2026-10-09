import { useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type SecretInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  sensitive?: boolean;
  secretLabel?: string;
  wrapperClassName?: string;
};

/** Visibility is local UI state; toggling it never edits or submits a credential. */
export default function SecretInput({
  sensitive = true,
  secretLabel,
  wrapperClassName = 'min-w-0 flex-1',
  className = '',
  ...props
}: SecretInputProps) {
  const [visible, setVisible] = useState(false);
  const { t } = useTranslation();
  const label = secretLabel || props['aria-label'] || props.name || t('server.key');
  return (
    <div className={`relative ${wrapperClassName}`}>
      <input
        {...props}
        type={sensitive && !visible ? 'password' : 'text'}
        className={`w-full ${className} ${sensitive ? '!pr-10' : ''}`}
      />
      {sensitive && (
        <button
          type="button"
          className="absolute inset-y-0 right-2 flex items-center text-[var(--hub-ink-2)] hover:text-[var(--hub-ink)]"
          aria-label={t(visible ? 'server.hideSecret' : 'server.showSecret', { name: label })}
          aria-pressed={visible}
          disabled={props.disabled}
          onClick={() => setVisible((previous) => !previous)}
        >
          {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </button>
      )}
    </div>
  );
}
