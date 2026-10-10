import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  ClipboardPaste,
  Film,
  FolderPlus,
  LayoutGrid,
  LibraryBig,
  List,
  LoaderCircle,
  Music2,
} from "lucide-react";
import { parentPath, type Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { formatBytes, formatDate, plural } from "../lib/format";
import { isEditableTarget, onMenuAction, showContextMenu, type MenuEntry } from "../lib/native";
import {
  addMediaSource,
  browseAccount,
  copyEntry,
  createFolder,
  openNativePath,
  playStorageFile,
  revealNativePath,
  type Account,
  type CloudEntry,
  type MediaSource,
} from "../lib/nimbus";
import { canCopyBetween, classifyEntry, isPlayableKind, storageCapabilities, validFolderName } from "../lib/storage";
import { EmptyState, SearchField, Segmented, useIncrementalCount } from "../ui/controls";
import { EntryIcon, ProviderGlyph } from "../ui/glyphs";
import { Sheet } from "../ui/Sheet";
import type { Notify } from "../ui/Toasts";
import { QuickLook } from "./QuickLook";

export type ClipboardEntry = { accountId: string; id: string; path: string; name: string; isDir: boolean };
type SortField = "name" | "modified" | "size" | "kind";
type Sort = { field: SortField; ascending: boolean };
type ViewMode = "list" | "grid";

const DRAG_TYPE = "application/x-cove-entry";
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function loadPreference<T>(key: string, fallback: T, valid: (value: unknown) => boolean): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return valid(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function savePreference(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Preferences are best effort.
  }
}

function parseDragged(raw: string): ClipboardEntry | null {
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

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

type Props = {
  library: Library;
  account: Account;
  path: string;
  clipboard: ClipboardEntry | null;
  onClipboard: (entry: ClipboardEntry | null) => void;
  onNavigate: (route: Route) => void;
  onRemoveSource: (source: MediaSource) => void;
  notify: Notify;
};

/** Finder-style browser: path bar, list and icon views, Quick Look, copy and paste. */
export function StorageView({ library, account, path, clipboard, onClipboard, onNavigate, onRemoveSource, notify }: Props) {
  const capabilities = storageCapabilities(account.provider);
  const virtualRoot = account.provider === "local" && path === "/";
  const canWrite = capabilities.copy && !virtualRoot;
  const clipboardAccount = library.accounts.find((item) => item.id === clipboard?.accountId);
  const canPaste = !!clipboard && !!clipboardAccount && canWrite && canCopyBetween(clipboardAccount, account);

  const [entries, setEntries] = useState<CloudEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>(() =>
    loadPreference<Sort>("cove-browser-sort", { field: "name", ascending: true }, (value) => !!value && typeof value === "object" && "field" in value),
  );
  const [view, setView] = useState<ViewMode>(() => loadPreference<ViewMode>("cove-browser-view", "list", (value) => value === "list" || value === "grid"));
  const [quickLook, setQuickLook] = useState<CloudEntry | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const request = useRef(0);
  const container = useRef<HTMLDivElement>(null);
  const lastCopy = useRef(0);

  useEffect(() => {
    const generation = ++request.current;
    setLoading(true);
    setError(null);
    browseAccount(account.id, path)
      .then((next) => {
        if (generation !== request.current) return;
        setEntries(next);
      })
      .catch((cause) => {
        if (generation !== request.current) return;
        setEntries([]);
        setError(errorText(cause));
      })
      .finally(() => {
        if (generation === request.current) setLoading(false);
      });
  }, [account.id, path, reload]);

  useEffect(() => {
    setSelected(null);
    setFilter("");
    setQuickLook(null);
  }, [account.id, path]);

  const sorted = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    const list = needle ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(needle)) : [...entries];
    const direction = sort.ascending ? 1 : -1;
    return list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let result = 0;
      if (sort.field === "size") result = (a.size || 0) - (b.size || 0);
      else if (sort.field === "modified") result = (a.modifiedAt || 0) - (b.modifiedAt || 0);
      else if (sort.field === "kind") result = collator.compare(classifyEntry(a.name, a.isDir).label, classifyEntry(b.name, b.isDir).label);
      return (result || collator.compare(a.name, b.name)) * (sort.field === "name" ? direction : result ? direction : 1);
    });
  }, [entries, filter, sort]);

  const { count, sentinel } = useIncrementalCount(sorted.length, 300, `${account.id}|${path}|${filter}|${sort.field}|${sort.ascending}`);
  const visible = sorted.slice(0, count);
  const selectedEntry = sorted.find((entry) => entry.id === selected) ?? null;

  const sourceAt = useCallback(
    (kind: MediaSource["kind"], folder: string) =>
      library.sources.find((source) => source.accountId === account.id && source.kind === kind && source.remoteRoot === folder),
    [account.id, library.sources],
  );

  const changeSort = (field: SortField) => {
    const next = sort.field === field ? { field, ascending: !sort.ascending } : { field, ascending: field === "name" || field === "kind" };
    setSort(next);
    savePreference("cove-browser-sort", next);
  };

  const changeView = (mode: ViewMode) => {
    setView(mode);
    savePreference("cove-browser-view", mode);
  };

  const go = (target: string) => onNavigate({ name: "storage", accountId: account.id, path: target });

  const play = async (entry: CloudEntry) => {
    const kind = classifyEntry(entry.name, false).kind;
    const siblings = entries.filter((item) => !item.isDir && classifyEntry(item.name, false).kind === kind);
    setPlayingId(entry.id);
    try {
      await playStorageFile(account.id, entry.path, entry.name, entry.id, siblings);
    } catch (cause) {
      notify(`无法播放“${entry.name}”：${errorText(cause)}`, "error");
    } finally {
      setPlayingId(null);
    }
  };

  const open = (entry: CloudEntry) => {
    if (entry.isDir) go(entry.path);
    else if (isPlayableKind(classifyEntry(entry.name, false).kind)) void play(entry);
    else setQuickLook(entry);
  };

  const copy = (entry: CloudEntry) => {
    if (!capabilities.copy) {
      notify("这个存储位置暂不支持拷贝", "info");
      return;
    }
    onClipboard({ accountId: account.id, id: entry.id, path: entry.path, name: entry.name, isDir: entry.isDir });
    notify(`已拷贝“${entry.name}”。打开目标文件夹后选择“粘贴”。`, "info");
  };

  const paste = async (destination = path, source = clipboard) => {
    if (!source) return;
    const sourceAccount = library.accounts.find((item) => item.id === source.accountId);
    if (!sourceAccount || !canCopyBetween(sourceAccount, account) || (account.provider === "local" && destination === "/")) {
      notify("无法粘贴到这个位置", "error");
      return;
    }
    setBusy(true);
    try {
      await copyEntry(source.accountId, source.path, source.id, source.isDir, account.id, destination);
      notify(`已将“${source.name}”拷贝到“${destination.split("/").filter(Boolean).at(-1) ?? account.label}”`, "success");
      if (destination === path) setReload((value) => value + 1);
    } catch (cause) {
      notify(`拷贝失败：${errorText(cause)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const addSource = async (kind: MediaSource["kind"], folder: string, name?: string) => {
    if (folder === "/") {
      notify("请选择具体的文件夹，不能把整个磁盘或网盘加入资料库。", "info");
      return;
    }
    try {
      const label = name ?? folder.split("/").filter(Boolean).at(-1) ?? account.label;
      const source = await addMediaSource(account.id, kind, folder, label);
      library.addSource(source);
      notify(`已将“${source.label}”设为${kind === "movie" ? "影视" : "音乐"}文件夹，正在扫描…`, "info");
    } catch (cause) {
      notify(`无法添加媒体文件夹：${errorText(cause)}`, "error");
    }
  };

  const libraryItems = (folder: string, name?: string): MenuEntry[] =>
    (["movie", "music"] as const).map((kind) => {
      const existing = sourceAt(kind, folder);
      const noun = kind === "movie" ? "影视文件夹" : "音乐文件夹";
      return existing
        ? { label: `移除${noun}…`, action: () => onRemoveSource(existing) }
        : { label: `设为${noun}`, enabled: folder !== "/", action: () => void addSource(kind, folder, name) };
    });

  const entryMenu = (event: React.MouseEvent, entry: CloudEntry) => {
    setSelected(entry.id);
    const kind = classifyEntry(entry.name, entry.isDir).kind;
    const items: MenuEntry[] = [
      { label: entry.isDir ? "打开" : isPlayableKind(kind) ? "播放" : "打开", action: () => open(entry) },
    ];
    if (!entry.isDir) items.push({ label: "快速查看", action: () => setQuickLook(entry) });
    if (capabilities.openNative) {
      if (!entry.isDir) items.push({ label: "用默认应用打开", action: () => void openNativePath(entry.path).catch((cause) => notify(errorText(cause), "error")) });
      items.push({ label: "在访达中显示", action: () => void revealNativePath(entry.path).catch((cause) => notify(errorText(cause), "error")) });
    }
    items.push("separator", { label: `拷贝“${entry.name}”`, enabled: capabilities.copy, action: () => copy(entry) });
    if (entry.isDir) {
      const pasteHere = !!clipboard && !!clipboardAccount && capabilities.copy && canCopyBetween(clipboardAccount, account) && !(account.provider === "local" && entry.path === "/");
      items.push({ label: clipboard ? `粘贴“${clipboard.name}”到此文件夹` : "粘贴", enabled: pasteHere, action: () => void paste(entry.path) });
      items.push("separator", ...libraryItems(entry.path, entry.name));
    }
    void showContextMenu(event, items);
  };

  const backgroundMenu = (event: React.MouseEvent) => {
    if ((event.target as Element).closest("[data-entry]")) return;
    setSelected(null);
    void showContextMenu(event, [
      { label: "新建文件夹", enabled: canWrite && capabilities.createFolder, action: () => setNewFolderOpen(true) },
      { label: clipboard ? `粘贴“${clipboard.name}”` : "粘贴", enabled: canPaste, action: () => void paste() },
      "separator",
      { label: "刷新", action: () => setReload((value) => value + 1) },
      { label: "以列表显示", checked: view === "list", action: () => changeView("list") },
      { label: "以图标显示", checked: view === "grid", action: () => changeView("grid") },
      ...(path !== "/" ? (["separator", ...libraryItems(path)] as MenuEntry[]) : []),
    ]);
  };

  useEffect(
    () =>
      onMenuAction((id) => {
        if (id === "cove.new-folder" && canWrite && capabilities.createFolder) setNewFolderOpen(true);
      }),
    [canWrite, capabilities.createFolder],
  );

  // Copy via the Edit menu or ⌘C when an item (not text) is selected.
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      if (!selectedEntry || isEditableTarget(document.activeElement) || !container.current?.contains(document.activeElement)) return;
      event.preventDefault();
      if (Date.now() - lastCopy.current > 300) copy(selectedEntry);
      lastCopy.current = Date.now();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(document.activeElement) || !container.current?.contains(document.activeElement) || !canPaste) return;
      event.preventDefault();
      void paste();
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  });

  const columnsInGrid = () => {
    const cards = container.current?.querySelectorAll<HTMLElement>(".icon-item");
    if (!cards || cards.length < 2) return 1;
    const top = cards[0].offsetTop;
    let columns = 0;
    for (const card of cards) {
      if (card.offsetTop !== top) break;
      columns++;
    }
    return Math.max(1, columns);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isEditableTarget(event.target)) return;
    const index = visible.findIndex((entry) => entry.id === selected);
    const select = (position: number) => {
      const entry = visible[Math.max(0, Math.min(visible.length - 1, position))];
      if (!entry) return;
      setSelected(entry.id);
      container.current?.querySelector(`[data-entry="${CSS.escape(entry.id)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    const step = view === "grid" ? columnsInGrid() : 1;
    if (event.metaKey && event.key === "ArrowUp") {
      event.preventDefault();
      const parent = parentPath(path);
      if (parent) go(parent);
    } else if ((event.metaKey && event.key === "ArrowDown") || event.key === "Enter") {
      event.preventDefault();
      if (selectedEntry) open(selectedEntry);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      select(index < 0 ? 0 : index + step);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      select(index < 0 ? 0 : index - step);
    } else if (view === "grid" && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      select(index < 0 ? 0 : index + (event.key === "ArrowRight" ? 1 : -1));
    } else if (event.key === " " && !event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      if (selectedEntry && !selectedEntry.isDir) setQuickLook(selectedEntry);
    } else if (event.key === "Home") {
      event.preventDefault();
      select(0);
    } else if (event.key === "End") {
      event.preventDefault();
      select(visible.length - 1);
    } else if (event.metaKey && event.key.toLowerCase() === "c" && selectedEntry) {
      event.preventDefault();
      if (Date.now() - lastCopy.current > 300) copy(selectedEntry);
      lastCopy.current = Date.now();
    } else if (event.metaKey && event.key.toLowerCase() === "v" && canPaste) {
      event.preventDefault();
      void paste();
    }
  };

  const dragProps = (entry: CloudEntry) => ({
    draggable: capabilities.copy,
    onDragStart: (event: React.DragEvent) => {
      const item = { accountId: account.id, id: entry.id, path: entry.path, name: entry.name, isDir: entry.isDir };
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
    },
    ...(entry.isDir
      ? {
          onDragOver: (event: React.DragEvent) => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "copy";
            setDropTarget(entry.id);
          },
          onDragLeave: () => setDropTarget((value) => (value === entry.id ? null : value)),
          onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setDropTarget(null);
            const dragged = parseDragged(event.dataTransfer.getData(DRAG_TYPE));
            if (dragged && dragged.path !== entry.path) void paste(entry.path, dragged);
          },
        }
      : {}),
  });

  const sortIndicator = (field: SortField) =>
    sort.field === field ? sort.ascending ? <ChevronUp size={11} /> : <ChevronDown size={11} /> : null;

  const crumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    return parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join("/")}` }));
  }, [path]);

  const movieSource = sourceAt("movie", path);
  const musicSource = sourceAt("music", path);
  const statusParts = [
    filter.trim() ? `${sorted.length} / ${plural(entries.length, "项")}` : plural(entries.length, "项"),
    selectedEntry ? `已选择“${selectedEntry.name}”` : null,
    !capabilities.copy ? "只读" : null,
    clipboard ? `剪贴板：${clipboard.name}` : null,
  ].filter(Boolean);

  return (
    <div
      ref={container}
      className="browser"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={backgroundMenu}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE) || !canWrite) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        const dragged = parseDragged(event.dataTransfer.getData(DRAG_TYPE));
        if (!dragged || !canWrite) return;
        event.preventDefault();
        if (dragged.accountId === account.id && parentPath(dragged.path) === path) return;
        void paste(path, dragged);
      }}
    >
      <div className="browser-bar">
        <nav className="pathbar" aria-label="路径">
          <button className="crumb" onClick={() => go("/")} disabled={path === "/"}>
            <ProviderGlyph provider={account.provider} size="small" />
            <span className="truncate">{account.label}</span>
          </button>
          {crumbs.map((crumb, index) => (
            <span className="crumb-wrap" key={crumb.path}>
              <ChevronRight size={12} className="crumb-separator" />
              <button className="crumb" disabled={index === crumbs.length - 1} onClick={() => go(crumb.path)} title={crumb.label}>
                <span className="truncate">{crumb.label}</span>
              </button>
            </span>
          ))}
          {(movieSource || musicSource) && (
            <span className="pathbar-badges">
              {movieSource && <span className="badge accent">影视文件夹</span>}
              {musicSource && <span className="badge accent">音乐文件夹</span>}
            </span>
          )}
        </nav>
        <div className="browser-tools">
          <button
            className="icon-btn"
            title={path === "/" ? "请选择具体的文件夹" : "资料库"}
            aria-label="资料库"
            disabled={path === "/"}
            onClick={(event) => void showContextMenu(event, libraryItems(path))}
          >
            <LibraryBig size={16} />
          </button>
          <button
            className="icon-btn"
            title={canWrite && capabilities.createFolder ? "新建文件夹 (⇧⌘N)" : "此位置不能新建文件夹"}
            aria-label="新建文件夹"
            disabled={!canWrite || !capabilities.createFolder || busy}
            onClick={() => setNewFolderOpen(true)}
          >
            <FolderPlus size={16} />
          </button>
          <button
            className="icon-btn"
            title={clipboard ? `粘贴“${clipboard.name}”` : "粘贴"}
            aria-label="粘贴"
            disabled={!canPaste || busy}
            onClick={() => void paste()}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <ClipboardPaste size={16} />}
          </button>
          <span className="toolbar-divider" />
          <Segmented<ViewMode>
            className="icons"
            ariaLabel="显示方式"
            value={view}
            onChange={changeView}
            options={[
              { value: "list", label: <List size={14} />, title: "列表" },
              { value: "grid", label: <LayoutGrid size={13} />, title: "图标" },
            ]}
          />
          <SearchField small value={filter} onChange={setFilter} placeholder="过滤" ariaLabel="过滤当前文件夹" style={{ width: 150 }} />
        </div>
      </div>

      <div className="browser-content">
        {error ? (
          <EmptyState icon={<CircleAlert size={40} strokeWidth={1.4} />} title="无法打开这个文件夹" message={error}>
            <button className="btn" onClick={() => setReload((value) => value + 1)}>
              重试
            </button>
            {parentPath(path) && (
              <button className="btn" onClick={() => go(parentPath(path) as string)}>
                返回上一级
              </button>
            )}
          </EmptyState>
        ) : loading && !entries.length ? (
          <div className="browser-loading">
            <LoaderCircle className="spin" size={20} />
          </div>
        ) : !sorted.length ? (
          <EmptyState
            compact
            title={filter.trim() ? "没有匹配的项目" : "文件夹是空的"}
            message={filter.trim() ? `没有名称包含“${filter.trim()}”的项目。` : undefined}
          />
        ) : view === "list" ? (
          <div
            className={`table files ${loading ? "refreshing" : ""}`}
            role="grid"
            aria-label="文件"
            tabIndex={0}
            style={{ "--columns": "minmax(200px, 3fr) minmax(150px, 1.4fr) 84px minmax(90px, 1fr)" } as CSSProperties}
          >
            <div className="table-header" role="row">
              <button className={`th ${sort.field === "name" ? "sorted" : ""}`} onClick={() => changeSort("name")}>
                名称 {sortIndicator("name")}
              </button>
              <button className={`th col-date ${sort.field === "modified" ? "sorted" : ""}`} onClick={() => changeSort("modified")}>
                修改日期 {sortIndicator("modified")}
              </button>
              <button className={`th end ${sort.field === "size" ? "sorted" : ""}`} onClick={() => changeSort("size")}>
                大小 {sortIndicator("size")}
              </button>
              <button className={`th ${sort.field === "kind" ? "sorted" : ""}`} onClick={() => changeSort("kind")}>
                种类 {sortIndicator("kind")}
              </button>
            </div>
            <div className="table-body">
              {visible.map((entry) => {
                const classification = classifyEntry(entry.name, entry.isDir);
                const source = entry.isDir ? sourceAt("movie", entry.path) ?? sourceAt("music", entry.path) : undefined;
                return (
                  <div
                    key={entry.id}
                    data-entry={entry.id}
                    role="row"
                    aria-selected={selected === entry.id}
                    className={`table-row ${dropTarget === entry.id ? "drop-target" : ""}`}
                    onMouseDown={() => setSelected(entry.id)}
                    onDoubleClick={() => open(entry)}
                    onContextMenu={(event) => entryMenu(event, entry)}
                    {...dragProps(entry)}
                  >
                    <span className="cell" title={entry.name}>
                      {playingId === entry.id ? <LoaderCircle className="spin" size={15} /> : <EntryIcon kind={classification.kind} />}
                      <span className="text">{entry.name}</span>
                      {source && (
                        <span className="badge accent">
                          {source.kind === "movie" ? <Film size={9} /> : <Music2 size={9} />}
                          {source.kind === "movie" ? "影视" : "音乐"}
                        </span>
                      )}
                    </span>
                    <span className="cell secondary col-date">
                      <span className="text">{formatDate(entry.modifiedAt)}</span>
                    </span>
                    <span className="cell end secondary tabular">{entry.isDir ? "--" : formatBytes(entry.size)}</span>
                    <span className="cell secondary">
                      <span className="text">{classification.label}</span>
                    </span>
                  </div>
                );
              })}
              <div ref={sentinel} className="sentinel" />
            </div>
          </div>
        ) : (
          <div className={`icon-grid ${loading ? "refreshing" : ""}`} role="grid" aria-label="文件" tabIndex={0}>
            {visible.map((entry) => {
              const classification = classifyEntry(entry.name, entry.isDir);
              return (
                <div
                  key={entry.id}
                  data-entry={entry.id}
                  role="gridcell"
                  aria-selected={selected === entry.id}
                  className={`icon-item ${dropTarget === entry.id ? "drop-target" : ""}`}
                  title={entry.name}
                  onMouseDown={() => setSelected(entry.id)}
                  onDoubleClick={() => open(entry)}
                  onContextMenu={(event) => entryMenu(event, entry)}
                  {...dragProps(entry)}
                >
                  <span className="icon-item-art">
                    {playingId === entry.id ? <LoaderCircle className="spin" size={24} /> : <EntryIcon kind={classification.kind} size={44} />}
                  </span>
                  <span className="icon-item-name">{entry.name}</span>
                  <span className="icon-item-meta">{entry.isDir ? "文件夹" : formatBytes(entry.size)}</span>
                </div>
              );
            })}
            <div ref={sentinel} className="sentinel" />
          </div>
        )}
      </div>

      <footer className="statusbar">{statusParts.join(" · ")}</footer>

      {quickLook && <QuickLook entry={quickLook} account={account} notify={notify} onClose={() => setQuickLook(null)} />}
      {newFolderOpen && (
        <NewFolderSheet
          onClose={() => setNewFolderOpen(false)}
          onCreate={async (name) => {
            await createFolder(account.id, path, name);
            setReload((value) => value + 1);
            notify(`已创建文件夹“${name}”`, "success");
          }}
        />
      )}
    </div>
  );
}

function NewFolderSheet({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState("未命名文件夹");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const valid = validFolderName(name);
  return (
    <Sheet onClose={saving ? () => undefined : onClose} labelledBy="new-folder-title" width={340} dismissOnBackdrop={false}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid || saving) return;
          setSaving(true);
          setError("");
          try {
            await onCreate(name.trim());
            onClose();
          } catch (cause) {
            setError(errorText(cause));
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="sheet-header">
          <h2 className="sheet-title" id="new-folder-title">
            新建文件夹
          </h2>
        </div>
        <div className="sheet-body">
          <input
            ref={input}
            className="field"
            value={name}
            aria-label="文件夹名称"
            data-autofocus
            onChange={(event) => setName(event.target.value)}
          />
          {!valid && name.trim() && <p className="form-note">名称不能包含“/”，也不能是“.”或“..”。</p>}
          {error && (
            <p className="form-error">
              <CircleAlert size={14} />
              {error}
            </p>
          )}
        </div>
        <div className="sheet-footer">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn prominent" disabled={!valid || saving}>
            {saving && <LoaderCircle className="spin" size={12} />}
            创建
          </button>
        </div>
      </form>
    </Sheet>
  );
}
