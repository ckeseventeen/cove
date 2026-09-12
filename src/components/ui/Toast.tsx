import { X } from "lucide-react";
import type { Toast as ToastType } from "../../hooks/useNotifications";

type Props = {
  toasts: ToastType[];
  onDismiss: (id: number) => void;
};

export function ToastContainer({ toasts, onDismiss }: Props) {
  if (!toasts.length) return null;
  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.type}`}
          role="alert"
        >
          <span>{toast.message}</span>
          <button
            className="icon-button toast-dismiss"
            aria-label="关闭通知"
            onClick={() => onDismiss(toast.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
