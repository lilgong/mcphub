import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleHelp } from 'lucide-react';

/** Clickable help remains available beside disabled controls and inside small dialogs. */
export default function SettingHint({
  label,
  children,
  unavailable = false,
}: {
  label: string;
  children: ReactNode;
  unavailable?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const close = () => setPosition(undefined);
  const open = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(320, window.innerWidth - 24);
    setPosition({
      left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
      top: Math.min(rect.bottom + 8, window.innerHeight - 140),
    });
  };
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!trigger.current?.contains(node) && !panel.current?.contains(node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', close);
    };
  }, [position]);
  const Icon = unavailable ? CircleAlert : CircleHelp;
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="hub-setting-hint"
        aria-label={label}
        aria-expanded={!!position}
        aria-controls={position ? id : undefined}
        onClick={() => (position ? close() : open())}
      >
        <Icon size={14} aria-hidden />
      </button>
      {position &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="note"
            aria-label={label}
            className="hub-setting-hint-panel"
            style={position}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
