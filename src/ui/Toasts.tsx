import { useCallback, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

export type ToastKind = "info" | "success" | "error";
export type Toast = { id: number; message: string; kind: ToastKind };
export type Notify = (message: string, kind?: ToastKind) => void;

let nextId = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback<Notify>(
    (message, kind = "info") => {
      if (!message.trim()) return;
      const id = nextId++;
      setToasts((current) => [...current.filter((toast) => toast.message !== message).slice(-2), { id, message, kind }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), kind === "error" ? 8000 : 4000));
    },
    [dismiss],
  );

  return { toasts, notify, dismiss };
}

const ICONS = { info: Info, success: CircleCheck, error: CircleAlert };

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind];
        return (
          <div key={toast.id} className={`toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
            <Icon size={15} />
            <span className="message">{toast.message}</span>
            <button className="icon-btn" aria-label="关闭通知" onClick={() => onDismiss(toast.id)}>
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
