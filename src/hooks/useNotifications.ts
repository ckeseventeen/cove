import { useCallback, useState } from "react";

export interface Toast {
  id: number;
  message: string;
  type: "info" | "success" | "error";
}

let nextToastId = 0;

export function useNotifications() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, type: Toast["type"] = "info") => {
    if (!message.trim()) return;
    const id = nextToastId++;
    setToasts((current) => [...current.slice(-3), { id, message, type }]);
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  return { toasts, notify, dismiss };
}
