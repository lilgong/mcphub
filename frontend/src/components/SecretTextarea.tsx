import { useState, type CSSProperties, type TextareaHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** A real multiline control preserves PEM newlines while its visibility changes. */
export default function SecretTextarea({
  sensitive = true,
  secretLabel,
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  sensitive?: boolean;
  secretLabel?: string;
}) {
  const [visible, setVisible] = useState(false);
  const { t } = useTranslation();
  const label = secretLabel || props['aria-label'] || props.name || t('server.key');
  return (
    <div className="relative min-w-0">
      <textarea
        {...props}
        className={`w-full ${className} ${sensitive ? '!pr-10' : ''}`}
        style={
          {
            ...props.style,
            WebkitTextSecurity: sensitive && !visible ? 'disc' : 'none',
          } as CSSProperties
        }
      />
      {sensitive && (
        <button
          type="button"
          className="absolute top-3 right-2 text-[var(--hub-ink-2)] hover:text-[var(--hub-ink)]"
          aria-label={t(visible ? 'server.hideSecret' : 'server.showSecret', { name: label })}
          aria-pressed={visible}
          onClick={() => setVisible((previous) => !previous)}
        >
          {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </button>
      )}
    </div>
  );
}
