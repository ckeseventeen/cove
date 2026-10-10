import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Only the top-most modal reacts to Escape, like stacked AppKit sheets.
const stack: string[] = [];

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

type Props = {
  onClose: () => void;
  children: ReactNode;
  label?: string;
  labelledBy?: string;
  width?: number;
  centered?: boolean;
  className?: string;
  /** Sheets that hold a form can opt out of closing on a backdrop click. */
  dismissOnBackdrop?: boolean;
};

export function useTopmostEscape(active: boolean, onEscape: () => void) {
  const id = useId();
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!active) return;
    stack.push(id);
    const listener = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || stack.at(-1) !== id) return;
      event.preventDefault();
      event.stopPropagation();
      handler.current();
    };
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
      const index = stack.lastIndexOf(id);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [active, id]);
}

export const isModalOpen = () => stack.length > 0;

export function Sheet({ onClose, children, label, labelledBy, width, centered, className, dismissOnBackdrop = true }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useTopmostEscape(true, onClose);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const preferred = node?.querySelector<HTMLElement>("[data-autofocus]");
    (preferred ?? node?.querySelector<HTMLElement>(FOCUSABLE) ?? node)?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const trapTab = (event: React.KeyboardEvent) => {
    if (event.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className={`sheet-backdrop ${centered ? "centered" : ""}`}
      onMouseDown={(event) => {
        if (dismissOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={className ?? "sheet"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={width ? ({ "--sheet-width": `${width}px` } as CSSProperties) : undefined}
        onKeyDown={trapTab}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
