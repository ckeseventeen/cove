import { Trash2 } from "lucide-react";
import type { Account, MediaSource } from "../lib/nimbus";

export type DeleteTarget =
  | { type: "account"; item: Account }
  | { type: "source"; item: MediaSource };

type Props = {
  target: DeleteTarget | null;
  onClose: () => void;
  onConfirm: () => void;
};

export function ConfirmDeleteDialog({ target, onClose, onConfirm }: Props) {
  if (!target) return null;

  const isAccount = target.type === "account";
  const title = isAccount
    ? "删除云盘账号？"
    : `移除${target.item.kind === "movie" ? "影视库" : "音乐库"}？`;

  const description = isAccount
    ? `将从 Nimbus 删除“${target.item.label}”以及对应媒体来源和本地索引。`
    : `将移除“${target.item.label}”及其本地索引。`;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="确认删除"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="confirm-icon">
          <Trash2 size={22} />
        </span>
        <h2>{title}</h2>
        <p>
          {description}
          <br />
          存储源中的原文件不会被删除。
        </p>
        <div className="dialog-actions">
          <button className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button danger" onClick={onConfirm}>
            确认删除
          </button>
        </div>
      </section>
    </div>
  );
}
