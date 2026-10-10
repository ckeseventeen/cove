import { useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Sheet } from "./Sheet";

export type AlertRequest = {
  title: string;
  message?: ReactNode;
  icon?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
};

/** NSAlert-style confirmation: icon, bold title, message, two equal buttons. */
export function Alert({ request, onClose }: { request: AlertRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await request.onConfirm();
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <Sheet onClose={busy ? () => undefined : onClose} label={request.title} centered className="alert">
      {request.icon && <div className="alert-icon">{request.icon}</div>}
      <p className="alert-title">{request.title}</p>
      {request.message && <p className="alert-message">{request.message}</p>}
      <div className="alert-buttons">
        <button className="btn" disabled={busy} onClick={onClose}>
          {request.cancelLabel ?? "取消"}
        </button>
        <button
          className={`btn prominent ${request.destructive ? "destructive" : ""}`}
          disabled={busy}
          data-autofocus
          onClick={() => void confirm()}
        >
          {busy && <LoaderCircle className="spin" size={13} />}
          {request.confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}
