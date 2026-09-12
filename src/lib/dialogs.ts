import { useEffect } from "react";
export function useDialogFocus() {
  useEffect(() => {
    let current: HTMLElement | null = null;
    let previous: HTMLElement | null = null;
    const sync = () => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      if (dialog === current) return;
      if (!dialog) { previous?.focus(); current = null; return; }
      previous = document.activeElement as HTMLElement; current = dialog;
      dialog.querySelector<HTMLElement>('input, button, select, [tabindex="0"]')?.focus();
    };
    const key = (event: KeyboardEvent) => {
      if (!current || event.key !== 'Tab') return;
      const items = [...current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const observer = new MutationObserver(sync); observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('keydown', key); sync();
    return () => { observer.disconnect(); document.removeEventListener('keydown', key); };
  }, []);
}
