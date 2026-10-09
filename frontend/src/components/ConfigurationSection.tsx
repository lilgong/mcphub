import { ChevronRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** Shared disclosure styling for optional server connection settings. */
export default function ConfigurationSection({
  title,
  icon: Icon,
  badge,
  open,
  children,
}: {
  title: string;
  icon: LucideIcon;
  badge?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="hub-config-section" open={open}>
      <summary className="hub-config-summary">
        <Icon size={16} className="hub-config-icon" aria-hidden />
        <span className="min-w-0 flex-1">{title}</span>
        {badge && <span className="hub-tag shrink-0">{badge}</span>}
        <ChevronRight size={14} className="hub-config-chevron" aria-hidden />
      </summary>
      <div className="hub-config-body">{children}</div>
    </details>
  );
}
