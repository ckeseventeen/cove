import { useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronUp, FileType2, LoaderCircle } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { formatBytes, formatRelative, plural } from "../lib/format";
import { containingFolder } from "../lib/media";
import { showContextMenu } from "../lib/native";
import { openDocumentFile, type MediaFile, type ReadingProgress } from "../lib/nimbus";
import { EmptyState, useIncrementalCount } from "../ui/controls";
import { EntryIcon } from "../ui/glyphs";
import type { Notify } from "../ui/Toasts";

type SortField = "name" | "folder" | "read" | "size";
type Sort = { field: SortField; ascending: boolean };

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/** The memory key the reader uses: the same file opened from Files shares it. */
export const documentKey = (file: MediaFile) => `${file.accountId}:${file.cloudPath || file.remotePath}`;

const titleOf = (file: MediaFile) => file.displayName.replace(/\.pdf$/i, "");
const folderOf = (file: MediaFile) => (file.cloudPath || file.remotePath).split("/").filter(Boolean).at(-2) ?? "";

export function readingLabel(progress?: ReadingProgress) {
  if (!progress || !progress.pageCount) return "未读";
  if (progress.page + 1 >= progress.pageCount) return "已读完";
  return `第 ${progress.page + 1} / ${progress.pageCount} 页`;
}

/** Open a library document, reporting failures as a toast; returns when the reader window is up. */
export function useOpenDocument(notify: Notify) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const busy = useRef(false);
  const open = async (file: MediaFile) => {
    if (busy.current) return;
    busy.current = true;
    setOpeningId(file.id);
    try {
      await openDocumentFile(file.id);
    } catch (cause) {
      notify(`无法打开“${file.displayName}”：${cause instanceof Error ? cause.message : String(cause)}`, "error");
    } finally {
      busy.current = false;
      setOpeningId(null);
    }
  };
  return { open, openingId };
}

type Props = { library: Library; sourceId?: string; onNavigate: (route: Route) => void; notify: Notify };

export function DocumentsView({ library, sourceId, onNavigate, notify }: Props) {
  const [sort, setSort] = useState<Sort>({ field: "name", ascending: true });
  const [selected, setSelected] = useState<string | null>(null);
  const { open, openingId } = useOpenDocument(notify);
  const source = library.sources.find((item) => item.id === sourceId);

  const documents = useMemo(() => {
    const scoped = sourceId
      ? library.documents.filter((file) => file.sourceIds?.includes(sourceId) || file.sourceId === sourceId)
      : library.documents;
    const direction = sort.ascending ? 1 : -1;
    const read = (file: MediaFile) => library.readingByKey.get(documentKey(file))?.updatedAt ?? 0;
    return [...scoped].sort((left, right) => {
      if (sort.field === "size") return direction * (left.size - right.size);
      if (sort.field === "read") return direction * (read(left) - read(right)) || collator.compare(titleOf(left), titleOf(right));
      if (sort.field === "folder") return direction * collator.compare(folderOf(left), folderOf(right)) || collator.compare(titleOf(left), titleOf(right));
      return direction * collator.compare(titleOf(left), titleOf(right));
    });
  }, [library.documents, library.readingByKey, sort, sourceId]);

  const { count, sentinel } = useIncrementalCount(documents.length, 200, `${sort.field}|${sort.ascending}|${sourceId}`);
  const visible = documents.slice(0, count);

  const header = (field: SortField, label: string, extra = "") => (
    <button
      className={`th ${extra} ${sort.field === field ? "sorted" : ""}`}
      onClick={() =>
        setSort((current) => ({
          field,
          ascending: current.field === field ? !current.ascending : field === "name" || field === "folder",
        }))
      }
    >
      {label}
      {sort.field === field && (sort.ascending ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
    </button>
  );

  return (
    <div className="page">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">{source?.label ?? "文档"}</h1>
          <p className="page-subtitle">
            {plural(documents.length, "份 PDF")}
            {source && (
              <>
                {" · "}
                <button className="btn plain inline" onClick={() => onNavigate({ name: "documents" })}>
                  显示全部文档
                </button>
              </>
            )}
          </p>
        </div>
      </header>
      {documents.length ? (
        <div
          className="table documents"
          role="grid"
          aria-label="文档"
          tabIndex={0}
          style={{ "--columns": "minmax(200px, 2.4fr) minmax(100px, 1fr) minmax(130px, 1fr) 80px" } as CSSProperties}
          onKeyDown={(event) => {
            const index = visible.findIndex((file) => file.id === selected);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
              if (next) setSelected(next.id);
            } else if ((event.key === "Enter" || event.key === " ") && index >= 0) {
              event.preventDefault();
              void open(visible[index]);
            }
          }}
        >
          <div className="table-header" role="row">
            {header("name", "名称")}
            {header("folder", "文件夹", "col-folder")}
            {header("read", "阅读进度")}
            {header("size", "大小", "end")}
          </div>
          <div className="table-body">
            {visible.map((file) => {
              const progress = library.readingByKey.get(documentKey(file));
              const ratio = progress?.pageCount ? Math.min(1, (progress.page + 1) / progress.pageCount) : 0;
              const folder = containingFolder(file);
              return (
                <div
                  key={file.id}
                  role="row"
                  aria-selected={selected === file.id}
                  className="table-row"
                  onMouseDown={() => setSelected(file.id)}
                  onDoubleClick={() => void open(file)}
                  onContextMenu={(event) => {
                    setSelected(file.id);
                    void showContextMenu(event, [
                      { label: "打开", action: () => void open(file) },
                      {
                        label: "在文件中显示",
                        enabled: !!folder,
                        action: () => folder && onNavigate({ name: "storage", accountId: file.accountId, path: folder }),
                      },
                    ]);
                  }}
                >
                  <span className="cell" title={file.displayName}>
                    {openingId === file.id ? <LoaderCircle className="spin" size={15} /> : <EntryIcon kind="pdf" />}
                    <span className="text">{titleOf(file)}</span>
                  </span>
                  <span className="cell secondary col-folder">
                    <span className="text">{folderOf(file)}</span>
                  </span>
                  <span className="cell secondary" title={progress ? `上次阅读：${formatRelative(progress.updatedAt)}` : undefined}>
                    {ratio > 0 && (
                      <span className="progress reading-bar">
                        <span style={{ width: `${ratio * 100}%` }} />
                      </span>
                    )}
                    <span className="text">{readingLabel(progress)}</span>
                  </span>
                  <span className="cell end secondary tabular">{formatBytes(file.size)}</span>
                </div>
              );
            })}
            <div ref={sentinel} className="sentinel" />
          </div>
        </div>
      ) : (
        <EmptyState
          icon={<FileType2 size={44} strokeWidth={1.3} />}
          title="还没有文档"
          message="在左侧“位置”中打开存放 PDF 的文件夹，选择“添加到资料库 ▸ 设为文档文件夹”。单个 PDF 也可以在文件中直接双击阅读。"
        >
          <button className="btn" onClick={() => onNavigate({ name: "storage", accountId: "local", path: "/" })}>
            打开本地磁盘
          </button>
        </EmptyState>
      )}
    </div>
  );
}
