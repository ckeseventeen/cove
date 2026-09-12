import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Eye,
  File,
  FileCode,
  FileText,
  Film,
  Folder,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  LayoutGrid,
  LayoutList,
  LoaderCircle,
  Music,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  addMediaSource,
  browseAccount,
  copyEntry,
  createFolder,
  openNativePath,
  playStorageFile,
  readTextPreview,
  revealNativePath,
  scanMediaSource,
  type Account,
  type CloudEntry,
  type MediaSource,
} from "../lib/nimbus";

import { canCopyBetween, storageCapabilities, validFolderName } from "../lib/storage";

export type ClipboardEntry = { accountId: string; id: string; path: string; name: string; isDir: boolean };

type SortField = "name" | "mtime" | "size" | "kind";
type SortOrder = "asc" | "desc";
type ViewMode = "list" | "grid";

type Props = {
  accounts: Account[];
  account: Account;
  sources: MediaSource[];
  clipboard: ClipboardEntry | null;
  onClipboardChange: (entry: ClipboardEntry | null) => void;
  onSourceAdded: (source: MediaSource) => void;
  onSourceRemoved: (source: MediaSource) => Promise<void>;
  onScanFinished: () => void;
  onNotice: (message: string) => void;
  scanningIds?: Set<string>;
  onTriggerScan?: (source: MediaSource) => void;
};

type EntryClassification = {
  kind: "folder" | "video" | "audio" | "document" | "image" | "code" | "other";
  label: string;
};

function classifyEntry(name: string, isDir: boolean): EntryClassification {
  if (isDir) return { kind: "folder", label: "文件夹" };
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "mkv", "mov", "avi", "wmv", "flv", "ts", "webm", "m4v"].includes(ext)) {
    return { kind: "video", label: "视频" };
  }
  if (["mp3", "flac", "m4a", "wav", "aac", "ogg", "opus", "ape"].includes(ext)) {
    return { kind: "audio", label: "音频" };
  }
  if (["pdf", "txt", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "rtf"].includes(ext)) {
    return { kind: "document", label: "文档" };
  }
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "heic"].includes(ext)) {
    return { kind: "image", label: "图片" };
  }
  if (["md", "markdown", "json", "yaml", "yml", "log", "csv", "xml", "html", "css", "js", "ts", "rs", "py", "sh", "toml", "sql"].includes(ext)) {
    return { kind: "code", label: "文本/代码" };
  }
  return { kind: "other", label: ext ? ext.toUpperCase() : "文件" };
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(timestamp?: number | null): string {
  if (!timestamp) return "--";
  const date = new Date(timestamp * 1000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function StorageBrowser({
  accounts,
  account,
  sources,
  clipboard,
  onClipboardChange,
  onSourceAdded,
  onSourceRemoved,
  onScanFinished,
  onNotice,
  scanningIds,
  onTriggerScan,
}: Props) {
  const request = useRef(0);
  const [pageSize, setPageSize] = useState(100);
  const capabilities = storageCapabilities(account.provider);
  const canWrite = capabilities.copy;
  const clipboardAccount = accounts.find(item => item.id === clipboard?.accountId);
  const canPaste = !!clipboardAccount && canCopyBetween(clipboardAccount, account);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<CloudEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [addingKeys, setAddingKeys] = useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState("");

  // Sort state
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");

  // View mode
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  // Play and preview states
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [previewEntry, setPreviewEntry] = useState<CloudEntry | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const sourceAt = (kind: MediaSource["kind"], remoteRoot: string) =>
    sources.find(
      (source) =>
        source.accountId === account.id &&
        source.kind === kind &&
        source.remoteRoot === remoteRoot
    );

  async function load(nextPath: string) {
    const generation = ++request.current;
    setLoading(true);
    setBrowseError(null);
    setSearchQuery("");
    try {
      const next = await browseAccount(account.id, nextPath);
      if (generation !== request.current) return;
      setEntries(next);
      setPath(nextPath);
      setPageSize(100);
    } catch (cause) {
      if (generation !== request.current) return;
      setBrowseError(`浏览失败：${String(cause)}`);
      onNotice(`浏览失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }

  useEffect(() => {
    const generation = ++request.current;
    setPageSize(100);
    setEntries([]);
    setPath("/");
    setSearchQuery("");
    setLoading(true);
    browseAccount(account.id, "/")
      .then((nextEntries) => {
        if (generation === request.current) setEntries(nextEntries);
      })
      .catch((cause) => {
        if (generation === request.current) { setBrowseError(`浏览失败：${String(cause)}`); onNotice(`浏览失败：${String(cause)}`); }
      })
      .finally(() => {
        if (generation === request.current) setLoading(false);
      });
    return () => { ++request.current; ++previewRequest.current; };
  }, [account.id]);

  async function add(kind: MediaSource["kind"], remoteRoot = path, name?: string) {
    if (remoteRoot === "/") {
      onNotice("不能把整个磁盘或网盘设为媒体库，请选择具体文件夹；其子文件夹会自动递归扫描。");
      return;
    }
    const key = `${kind}:${remoteRoot}`;
    setAddingKeys((prev) => new Set(prev).add(key));
    try {
      const source = await addMediaSource(
        account.id,
        kind,
        remoteRoot,
        name ?? remoteRoot.split("/").filter(Boolean).at(-1) ?? account.label
      );
      onSourceAdded(source);
      onNotice(`已添加${kind === "movie" ? "影视" : "音乐"}目录“${source.label}”，正在后台扫描…`);
      if (onTriggerScan) {
        onTriggerScan(source);
      } else {
        void scanMediaSource(source.id)
          .then((result) => {
            onScanFinished();
            onNotice(
              `${result.truncated ? "部分扫描完成，原有索引保留" : "扫描完成"}：${source.label} 新增或更新 ${
                result.mediaFiles
              } 个${kind === "movie" ? "视频" : "音频"}`
            );
          })
          .catch((cause) => {
            onNotice(`扫描失败：${cause instanceof Error ? cause.message : String(cause)}`);
          });
      }
    } catch (cause) {
      onNotice(`添加媒体目录失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setAddingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function paste(destination = path, source = clipboard) {
    if (!source) return;
    const sourceAccount = accounts.find(item => item.id === source.accountId);
    if (!sourceAccount || !canCopyBetween(sourceAccount, account)) { onNotice("这两个存储位置暂不支持复制"); return; }
    setLoading(true);
    try {
      await copyEntry(source.accountId, source.path, source.id, source.isDir, account.id, destination);
      onNotice(`已将“${source.name}”复制到 ${destination}`);
      if (destination === path) await load(path);
      else setLoading(false);
    } catch (cause) {
      onNotice(`复制失败：${cause instanceof Error ? cause.message : String(cause)}`);
      setLoading(false);
    }
  }

  async function submitFolder() {
    if (!validFolderName(folderName)) { onNotice("文件夹名称不能包含斜杠，且不能为 . 或 .."); return; }
    setLoading(true);
    try {
      await createFolder(account.id, path, folderName);
      setFolderName("");
      setCreatingFolder(false);
      await load(path);
      onNotice("文件夹已创建");
    } catch (cause) {
      onNotice(`新建文件夹失败：${cause instanceof Error ? cause.message : String(cause)}`);
      setLoading(false);
    }
  }

  async function handlePlay(entry: CloudEntry) {
    setPlayingId(entry.id);

    try {
      const kind = classifyEntry(entry.name, false).kind;
      const videoSiblings = entries.filter(
        (e) => !e.isDir && classifyEntry(e.name, false).kind === kind
      );
      await playStorageFile(account.id, entry.path, entry.name, entry.id, videoSiblings);
    } catch (cause) {
      onNotice(`播放失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setPlayingId(null);
    }
  }

  async function handleOpenNative(filePath: string) {
    try {
      await openNativePath(filePath);
      onNotice("已调用系统关联应用打开");
    } catch (cause) {
      onNotice(`打开失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function handleRevealNative(filePath: string) {
    try {
      await revealNativePath(filePath);
    } catch (cause) {
      onNotice(`访达定位失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  function closePreview() { ++previewRequest.current; setPreviewEntry(null); setPreviewLoading(false); }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") closePreview(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);

  async function handlePreview(entry: CloudEntry) {
    const generation = ++previewRequest.current;
    setPreviewEntry(entry); setPreviewText(null); setPreviewError(null);
    const classification = classifyEntry(entry.name, false);
    if (!capabilities.textPreview || !["code", "document"].includes(classification.kind)) {
      setPreviewLoading(false); return;
    }
    setPreviewLoading(true);
    try {
      const text = await readTextPreview(entry.path);
      if (generation === previewRequest.current) setPreviewText(text);
    } catch (error) {
      if (generation === previewRequest.current) setPreviewError(String(error));
    } finally {
      if (generation === previewRequest.current) setPreviewLoading(false);
    }
  }

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder(field === "size" || field === "mtime" ? "desc" : "asc");
    }
  }

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, searchQuery]);

  const sortedEntries = useMemo(() => {
    if (sortField === "kind") {
      const kindMap = new Map<CloudEntry, string>();
      for (const item of filteredEntries) {
        kindMap.set(item, classifyEntry(item.name, item.isDir).label);
      }
      const list = [...filteredEntries];
      list.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        const kindA = kindMap.get(a) || "";
        const kindB = kindMap.get(b) || "";
        const comparison = kindA.localeCompare(kindB, "zh-CN");
        return sortOrder === "asc" ? comparison : -comparison;
      });
      return list;
    }

    const list = [...filteredEntries];
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let comparison = 0;
      switch (sortField) {
        case "name":
          comparison = a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
          break;
        case "size":
          comparison = (a.size || 0) - (b.size || 0);
          break;
        case "mtime":
          comparison = (a.modifiedAt || 0) - (b.modifiedAt || 0);
          break;
      }
      return sortOrder === "asc" ? comparison : -comparison;
    });
    return list;
  }, [filteredEntries, sortField, sortOrder]);

  function renderEntryIcon(entry: CloudEntry, size = 18) {
    if (entry.isDir) {
      return account.provider === "local" && path === "/" ? <HardDrive size={size} /> : <Folder size={size} />;
    }
    const classification = classifyEntry(entry.name, false);
    switch (classification.kind) {
      case "video":
        return <Film size={size} />;
      case "audio":
        return <Music size={size} />;
      case "document":
        return <FileText size={size} />;
      case "image":
        return <ImageIcon size={size} />;
      case "code":
        return <FileCode size={size} />;
      default:
        return <File size={size} />;
    }
  }

  function sourceButton(kind: MediaSource["kind"], remoteRoot: string, name?: string, compact = false) {
    const key = `${kind}:${remoteRoot}`;
    const existing = sourceAt(kind, remoteRoot);
    const isAdding = addingKeys.has(key);
    const isScanning = existing && scanningIds?.has(existing.id);

    if (existing) {
      return (
        <button
          type="button"
          className="unassign-button"
          disabled={isAdding}
          onClick={() => onSourceRemoved(existing)}
        >
          {isScanning ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
          {isScanning ? "扫描中" : `移除${compact ? "" : kind === "movie" ? "影视库" : "音乐库"}`}
        </button>
      );
    }
    return (
      <button
        type="button"
        className={compact ? "" : "button secondary"}
        disabled={isAdding}
        onClick={() => add(kind, remoteRoot, name)}
      >
        {isAdding ? (
          <LoaderCircle className="spin" size={compact ? 13 : 15} />
        ) : kind === "movie" ? (
          <Film size={compact ? 13 : 15} />
        ) : (
          <Music size={compact ? 13 : 15} />
        )}
        {compact ? (kind === "movie" ? "影视" : "音乐") : `设为${kind === "movie" ? "影视库" : "音乐库"}`}
      </button>
    );
  }

  const parent = path === "/" ? null : path.split("/").slice(0, -1).join("/") || "/";
  const crumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    const list: { label: string; path: string }[] = [{ label: "根目录", path: "/" }];
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      list.push({ label: part, path: current });
    }
    return list;
  }, [path]);

  return (
    <section className="browser-panel">
      <header className="browser-heading">
        <div>
          <p className="eyebrow">{account.provider === "local" ? "这台 Mac" : account.label}</p>
          <h2>{account.provider === "local" ? "浏览本地磁盘" : `浏览${account.label}`}</h2>
          <nav className="breadcrumbs" aria-label="目录层级">
            {crumbs.map((crumb, idx) => (
              <span key={crumb.path} className="breadcrumb-item">
                {idx > 0 && <ChevronRight size={13} className="crumb-separator" />}
                {idx === crumbs.length - 1 ? (
                  <span className="crumb-current">{crumb.label}</span>
                ) : (
                  <button type="button" className="crumb-link" onClick={() => void load(crumb.path)}>
                    {crumb.label}
                  </button>
                )}
              </span>
            ))}
            <span className="crumb-mode">{canWrite ? " · 拖到文件夹即复制" : " · 只读浏览"}</span>
          </nav>
        </div>
        <div className="browser-actions">
          <button
            type="button"
            disabled={!canWrite || loading || (account.provider === "local" && path === "/")}
            className="button secondary"
            onClick={() => setCreatingFolder((value) => !value)}
          >
            <Plus size={15} />新建文件夹
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!canPaste || loading || (account.provider === "local" && path === "/")}
            onClick={() => paste()}
          >
            <ClipboardPaste size={15} />粘贴{clipboard ? `“${clipboard.name}”` : ""}
          </button>
          {path === "/" ? (
            <span className="root-scan-hint">选择具体文件夹建立媒体库</span>
          ) : (
            <>
              {sourceButton("movie", path)}
              {sourceButton("music", path)}
            </>
          )}
        </div>
      </header>

      {/* Modern Finder-like Browser Control Bar */}
      <div className="browser-control-bar">
        <div className="browser-search-box">
          <Search size={14} className="browser-search-icon" />
          <input
            type="text"
            value={searchQuery}
            placeholder="搜索当前目录文件…"
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="browser-search-clear"
              aria-label="清除搜索"
              onClick={() => setSearchQuery("")}
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="browser-meta-info">
          <span>共 {entries.length} 项</span>
          {searchQuery.trim() && (
            <span className="search-match-badge">
              匹配 {filteredEntries.length} 项
            </span>
          )}
        </div>

        <div className="browser-view-controls">
          <div className="browser-sort-select">
            <ArrowUpDown size={13} />
            <select
              value={`${sortField}-${sortOrder}`}
              onChange={(e) => {
                const [field, order] = e.target.value.split("-") as [SortField, SortOrder];
                setSortField(field);
                setSortOrder(order);
              }}
              aria-label="文件排序方式"
            >
              <option value="name-asc">名称（升序 A-Z）</option>
              <option value="name-desc">名称（降序 Z-A）</option>
              <option value="mtime-desc">修改时间（最新优先）</option>
              <option value="mtime-asc">修改时间（最早优先）</option>
              <option value="size-desc">文件大小（从大到小）</option>
              <option value="size-asc">文件大小（从小到大）</option>
              <option value="kind-asc">种类（按类型分组）</option>
            </select>
          </div>

          <div className="view-mode-toggle">
            <button
              type="button"
              className={viewMode === "list" ? "active" : ""}
              title="列表展示"
              aria-label="切换为列表视图"
              onClick={() => setViewMode("list")}
            >
              <LayoutList size={15} />
            </button>
            <button
              type="button"
              className={viewMode === "grid" ? "active" : ""}
              title="大图标网格展示"
              aria-label="切换为图标视图"
              onClick={() => setViewMode("grid")}
            >
              <LayoutGrid size={15} />
            </button>
          </div>
        </div>
      </div>

      {creatingFolder && (
        <form
          className="inline-folder-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitFolder();
          }}
        >
          <input
            autoFocus
            value={folderName}
            placeholder="新文件夹名称"
            onChange={(event) => setFolderName(event.target.value)}
          />
          <button className="button primary" disabled={!folderName.trim() || loading}>
            创建
          </button>
        </form>
      )}

      {/* Main Files Area */}
      <div
        className="file-list-container"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const raw = event.dataTransfer.getData("application/x-nimbus-entry");
          const source = parseClipboard(raw) ?? clipboard;
          void paste(path, source);
        }}
      >
        {parent && (
          <button type="button" className="file-row return-parent-row" onClick={() => load(parent)}>
            <FolderPlus size={18} />
            <span>返回上一级 ({parent === "/" ? "根目录" : parent.split("/").pop()})</span>
          </button>
        )}

        {loading ? (
          <div className="browser-empty">
            <LoaderCircle className="spin" size={22} />
            正在处理目录…
          </div>
        ) : sortedEntries.length === 0 && !browseError ? (
          <div className="browser-empty">
            <RefreshCw size={20} />
            {searchQuery ? `未找到与“${searchQuery}”匹配的文件` : "这个目录是空的"}
          </div>
        ) : viewMode === "list" ? (
          /* ================= LIST VIEW (TABLE) ================= */
          <div className="browser-table-wrapper">
            <div className="browser-table-header">
              <button
                type="button"
                className={`table-th th-name ${sortField === "name" ? "sorted" : ""}`}
                onClick={() => toggleSort("name")}
              >
                名称 {sortField === "name" && (sortOrder === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
              </button>
              <button
                type="button"
                className={`table-th th-date ${sortField === "mtime" ? "sorted" : ""}`}
                onClick={() => toggleSort("mtime")}
              >
                修改时间 {sortField === "mtime" && (sortOrder === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
              </button>
              <button
                type="button"
                className={`table-th th-size ${sortField === "size" ? "sorted" : ""}`}
                onClick={() => toggleSort("size")}
              >
                大小 {sortField === "size" && (sortOrder === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
              </button>
              <button
                type="button"
                className={`table-th th-kind ${sortField === "kind" ? "sorted" : ""}`}
                onClick={() => toggleSort("kind")}
              >
                种类 {sortField === "kind" && (sortOrder === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
              </button>
              <div className="table-th th-actions">操作</div>
            </div>

            <div className="browser-table-body">
              {sortedEntries.slice(0, pageSize).map((entry) => {
                const item = {
                  accountId: account.id,
                  id: entry.id,
                  path: entry.path,
                  name: entry.name,
                  isDir: entry.isDir,
                };
                const classification = classifyEntry(entry.name, entry.isDir);
                const isMedia = classification.kind === "video" || classification.kind === "audio";
                const isDoc =
                  classification.kind === "document" ||
                  classification.kind === "code" ||
                  classification.kind === "image";

                return (
                  <div
                    key={entry.id}
                    className={`browser-table-row ${entry.isDir ? "is-folder" : ""}`}
                    draggable={canWrite}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "copy";
                      event.dataTransfer.setData("application/x-nimbus-entry", JSON.stringify(item));
                      onClipboardChange(item);
                    }}
                    onDragOver={
                      entry.isDir
                        ? (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            event.dataTransfer.dropEffect = "copy";
                          }
                        : undefined
                    }
                    onDrop={
                      entry.isDir
                        ? (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const raw = event.dataTransfer.getData("application/x-nimbus-entry");
                            void paste(entry.path, parseClipboard(raw) ?? clipboard);
                          }
                        : undefined
                    }
                  >
                    <div
                      className="table-cell td-name"
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (entry.isDir) void load(entry.path);
                        else if (isMedia) void handlePlay(entry);
                        else void handlePreview(entry);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (entry.isDir) void load(entry.path);
                          else if (isMedia) void handlePlay(entry);
                          else void handlePreview(entry);
                        }
                      }}
                    >
                      <span className={`cell-icon kind-${classification.kind}`}>
                        {renderEntryIcon(entry, 16)}
                      </span>
                      <span className="entry-title" title={entry.name}>
                        {entry.name}
                      </span>
                      {entry.isDir && <ChevronRight size={13} className="folder-arrow" />}
                    </div>

                    <div className="table-cell td-date">{formatDate(entry.modifiedAt)}</div>
                    <div className="table-cell td-size">{formatSize(entry.size)}</div>
                    <div className="table-cell td-kind">
                      <span className={`kind-tag kind-${classification.kind}`}>
                        {classification.label}
                      </span>
                    </div>

                    <div className="table-cell td-actions">
                      {isMedia && (
                        <button
                          type="button"
                          className="table-action-btn primary"
                          title="直接播放"
                          disabled={playingId === entry.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handlePlay(entry);
                          }}
                        >
                          {playingId === entry.id ? <LoaderCircle className="spin" size={13} /> : <Play size={13} fill="currentColor" />}
                          播放
                        </button>
                      )}

                      {isDoc && (
                        <button
                          type="button"
                          className="table-action-btn"
                          title="在应用内预览文档"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handlePreview(entry);
                          }}
                        >
                          <Eye size={13} />
                          预览
                        </button>
                      )}

                      {account.provider === "local" && !entry.isDir && (
                        <button
                          type="button"
                          className="table-action-btn"
                          title="用本机系统默认应用打开"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleOpenNative(entry.path);
                          }}
                        >
                          <ExternalLink size={13} />
                        </button>
                      )}

                      <button
                        type="button"
                        className="copy-entry-button"
                        disabled={!canWrite}
                        title={canWrite ? "复制" : "此来源暂不支持复制"}
                        aria-label={`复制${entry.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onClipboardChange(item);
                          onNotice(`已复制“${entry.name}”，进入目标目录后点击粘贴，或直接拖到目标文件夹。`);
                        }}
                      >
                        <Copy size={13} />
                      </button>

                      {entry.isDir && (
                        <div className="folder-actions" onClick={(e) => e.stopPropagation()}>
                          {sourceButton("movie", entry.path, entry.name, true)}
                          {sourceButton("music", entry.path, entry.name, true)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          /* ================= GRID VIEW (BIG ICONS) ================= */
          <div className="browser-grid-view">
            {sortedEntries.slice(0, pageSize).map((entry) => {
              const item = {
                accountId: account.id,
                id: entry.id,
                path: entry.path,
                name: entry.name,
                isDir: entry.isDir,
              };
              const classification = classifyEntry(entry.name, entry.isDir);
              const isMedia = classification.kind === "video" || classification.kind === "audio";
              const isDoc =
                classification.kind === "document" ||
                classification.kind === "code" ||
                classification.kind === "image";

              return (
                <div
                  key={entry.id}
                  className={`browser-grid-card kind-${classification.kind} ${entry.isDir ? "is-dir" : ""}`}
                  draggable={canWrite}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData("application/x-nimbus-entry", JSON.stringify(item));
                    onClipboardChange(item);
                  }}
                  onDragOver={
                    entry.isDir
                      ? (event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = "copy";
                        }
                      : undefined
                  }
                  onDrop={
                    entry.isDir
                      ? (event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const raw = event.dataTransfer.getData("application/x-nimbus-entry");
                          void paste(entry.path, parseClipboard(raw) ?? clipboard);
                        }
                      : undefined
                  }
                  onClick={() => {
                    if (entry.isDir) void load(entry.path);
                    else if (isMedia) void handlePlay(entry);
                    else void handlePreview(entry);
                  }}
                >
                  <div className="grid-icon-wrapper">
                    {renderEntryIcon(entry, 38)}
                    {isMedia && (
                      <button
                        type="button"
                        className="grid-play-badge"
                        title="播放"
                        disabled={playingId === entry.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handlePlay(entry);
                        }}
                      >
                        {playingId === entry.id ? <LoaderCircle className="spin" size={16} /> : <Play size={16} fill="currentColor" />}
                      </button>
                    )}
                  </div>

                  <div className="grid-card-details">
                    <strong className="grid-entry-title" title={entry.name}>
                      {entry.name}
                    </strong>
                    <div className="grid-meta-row">
                      <span>{entry.isDir ? "文件夹" : formatSize(entry.size)}</span>
                      {entry.modifiedAt ? <span>{formatDate(entry.modifiedAt).slice(5, 10)}</span> : null}
                    </div>
                  </div>

                  <div className="grid-card-hover-actions" onClick={(e) => e.stopPropagation()}>
                    {isDoc && (
                      <button
                        type="button"
                        className="grid-quick-btn"
                        title="预览文档"
                        onClick={() => void handlePreview(entry)}
                      >
                        <Eye size={13} />
                      </button>
                    )}
                    {account.provider === "local" && (
                      <button
                        type="button"
                        className="grid-quick-btn"
                        title="用本机默认应用打开"
                        onClick={() => void handleOpenNative(entry.path)}
                      >
                        <ExternalLink size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="grid-quick-btn"
                      disabled={!canWrite}
                      title="复制"
                      onClick={() => {
                        onClipboardChange(item);
                        onNotice(`已复制“${entry.name}”`);
                      }}
                    >
                      <Copy size={13} />
                    </button>
                    {entry.isDir && (
                      <div className="grid-source-btns">
                        {sourceButton("movie", entry.path, entry.name, true)}
                        {sourceButton("music", entry.path, entry.name, true)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!loading && sortedEntries.length > pageSize && (
          <button
            type="button"
            className="button secondary load-more"
            onClick={() => setPageSize((size) => size + 100)}
          >
            加载更多（剩余 {sortedEntries.length - pageSize} 项）
          </button>
        )}
      </div>

      {browseError && <div role="alert" className="home-empty"><span>{browseError}</span><button className="button secondary" onClick={() => void load(path)}>重试</button></div>}
      {/* ================= DOCUMENT PREVIEW DIALOG ================= */}
      {previewEntry && (
        <div
          className="dialog-backdrop document-preview-backdrop"
          onClick={closePreview}
        >
          <div
            className="dialog document-preview-dialog" role="dialog" aria-modal="true" aria-label={`${previewEntry.name} 预览`}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="document-preview-header">
              <div className="document-preview-title">
                <span className="preview-icon-badge">
                  {renderEntryIcon(previewEntry, 20)}
                </span>
                <div>
                  <h3>{previewEntry.name}</h3>
                  <div className="document-preview-meta">
                    <span>{formatSize(previewEntry.size)}</span>
                    <span>·</span>
                    <span>{formatDate(previewEntry.modifiedAt)}</span>
                    <span>·</span>
                    <span>{classifyEntry(previewEntry.name, false).label}</span>
                  </div>
                </div>
              </div>

              <div className="document-preview-actions">
                {account.provider === "local" && (
                  <>
                    <button
                      type="button"
                      className="button primary compact"
                      onClick={() => void handleOpenNative(previewEntry.path)}
                      title="调用 macOS 默认关联程序打开（如 Typora, Preview, VSCode, Pages 等）"
                    >
                      <ExternalLink size={14} />
                      用系统默认应用打开
                    </button>
                    <button
                      type="button"
                      className="button secondary compact"
                      onClick={() => void handleRevealNative(previewEntry.path)}
                      title="在 macOS 访达中定位该文件"
                    >
                      在访达中显示
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="icon-button preview-close-btn"
                  aria-label="关闭预览"
                  onClick={closePreview}
                >
                  <X size={18} />
                </button>
              </div>
            </header>

            <div className="document-preview-body">
              {previewError && <p role="status" className="space-file-note">{previewError}</p>}
              {previewLoading ? (
                <div className="preview-loading">
                  <LoaderCircle className="spin" size={26} />
                  <span>正在读取文档内容…</span>
                </div>
              ) : previewText !== null ? (
                <div className="document-content-scroll">
                  <pre className="document-text-content">
                    <code>{previewText}</code>
                  </pre>
                </div>
              ) : (
                <div className="document-binary-hint">
                  <div className="hint-icon-box">
                    {renderEntryIcon(previewEntry, 48)}
                  </div>
                  <h4>{previewEntry.name}</h4>
                  <p>
                    {account.provider === "local"
                      ? "该文件格式已支持通过 macOS 原生应用直接打开阅读（如预览、Typora、VSCode、Office 等）。"
                      : "云端二进制文档建议下载至本地后通过本地应用打开阅读。"}
                  </p>
                  {account.provider === "local" && (
                    <button
                      type="button"
                      className="button primary"
                      onClick={() => void handleOpenNative(previewEntry.path)}
                    >
                      <ExternalLink size={16} />
                      使用本机关联程序阅读
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function parseClipboard(raw: string): ClipboardEntry | null {
  try {
    const value = JSON.parse(raw);
    return value &&
      typeof value.accountId === "string" &&
      typeof value.path === "string" &&
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      typeof value.isDir === "boolean"
      ? value
      : null;
  } catch {
    return null;
  }
}
