import { useEffect, useRef, useState } from "react";
import { CircleAlert, ExternalLink, LoaderCircle, X } from "lucide-react";
import { formatBytes, formatDate } from "../lib/format";
import { isEditableTarget } from "../lib/native";
import { openNativePath, readTextPreview, revealNativePath, type Account, type CloudEntry } from "../lib/nimbus";
import { classifyEntry, storageCapabilities } from "../lib/storage";
import { EntryIcon } from "../ui/glyphs";
import { Sheet } from "../ui/Sheet";
import type { Notify } from "../ui/Toasts";

/** Space-bar preview. Text is read only for local files; everything else offers the system app. */
export function QuickLook({ entry, account, onClose, notify }: { entry: CloudEntry; account: Account; onClose: () => void; notify: Notify }) {
  const capabilities = storageCapabilities(account.provider);
  const classification = classifyEntry(entry.name, entry.isDir);
  const readable = capabilities.textPreview && classification.kind === "text";
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(readable);
  const request = useRef(0);

  useEffect(() => {
    const generation = ++request.current;
    setText(null);
    setError(null);
    if (!readable) {
      setLoading(false);
      return;
    }
    setLoading(true);
    readTextPreview(entry.path)
      .then((value) => {
        if (generation === request.current) setText(value);
      })
      .catch((cause) => {
        if (generation === request.current) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (generation === request.current) setLoading(false);
      });
    return () => {
      request.current++;
    };
  }, [entry.path, readable]);

  const run = (action: (path: string) => Promise<void>, failure: string) =>
    void action(entry.path).catch((cause) => notify(`${failure}：${cause instanceof Error ? cause.message : String(cause)}`, "error"));

  return (
    <Sheet onClose={onClose} label={`快速查看 ${entry.name}`} width={760} centered className="sheet quicklook">
      <div
        className="quicklook-inner"
        onKeyDown={(event) => {
          // Space closes Quick Look as in Finder, even on the focused “打开” button.
          if (event.key === " " && !isEditableTarget(event.target)) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="quicklook-header">
          <EntryIcon kind={classification.kind} size={22} />
          <div className="quicklook-title">
            <h2 className="truncate" title={entry.name}>
              {entry.name}
            </h2>
            <p className="secondary">
              {classification.label} · {formatBytes(entry.size, "未知大小")} · {formatDate(entry.modifiedAt)}
            </p>
          </div>
          {capabilities.openNative && (
            <>
              <button className="btn" onClick={() => run(revealNativePath, "无法在访达中显示")}>
                在访达中显示
              </button>
              <button className="btn prominent" data-autofocus onClick={() => run(openNativePath, "无法打开")}>
                <ExternalLink size={12} />
                打开
              </button>
            </>
          )}
          <button className="icon-btn" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="quicklook-body" tabIndex={0}>
          {loading ? (
            <div className="quicklook-placeholder">
              <LoaderCircle className="spin" size={22} />
            </div>
          ) : text !== null ? (
            <pre className="quicklook-text selectable">{text}</pre>
          ) : (
            <div className="quicklook-placeholder">
              <EntryIcon kind={classification.kind} size={72} />
              {error ? (
                <p className="form-error">
                  <CircleAlert size={14} />
                  {error}
                </p>
              ) : (
                <p className="secondary">
                  {capabilities.openNative
                    ? "此类文件请使用系统中的应用打开。"
                    : "云端文件暂不支持预览。可以先拷贝到这台 Mac，再用系统应用打开。"}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
