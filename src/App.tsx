import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CircleHelp,
  Cloud,
  Film,
  FolderOpen,
  Library,
  LoaderCircle,
  Music,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Waves,
  X,
} from "lucide-react";

import { useMediaLibrary, useMovieShelves, useMusicFiles } from "./hooks/useMediaLibrary";
import { useNotifications } from "./hooks/useNotifications";
import { ToastContainer } from "./components/ui/Toast";

import { AddAccountDialog } from "./components/AddAccountDialog";
import { ConfirmDeleteDialog, type DeleteTarget } from "./components/ConfirmDeleteDialog";
import { MovieDetailModal } from "./components/MovieDetailModal";
import { MusicPlayerBar } from "./components/MusicPlayerBar";
import { PlayerControlsWindow } from "./components/PlayerControlsWindow";
import { StorageBrowser, type ClipboardEntry } from "./components/StorageBrowser";
import { useDialogFocus } from "./lib/dialogs";
import {
  providerName,
  type MediaWork,
} from "./lib/media";
import {
  clearMetadataCache,
  controlPlayer,
  getCurrentPlayerFile,
  openNativePlayer,
  removeAccount,
  removeMediaSource,
  scanMediaSource,
  subscribePlayer,
  type Account,
  type MediaFile,
  type MediaSource,
  type MovieMetadata,
} from "./lib/nimbus";
import { HelpView } from "./views/HelpView";
import { HomeView } from "./views/HomeView";
import { MovieView, type MovieCategory, type MovieSort } from "./views/MovieView";
import { MusicView, type MusicSort } from "./views/MusicView";
import { SettingsView } from "./views/SettingsView";
import { SourcesView } from "./views/SourcesView";

import { FilesView } from "./views/FilesView";
import { SearchView } from "./views/SearchView";

type View = "files" | "search" | "sources" | "library" | "movie" | "music" | "storage" | "settings" | "help";

export default function App() {
  useDialogFocus();

  if (new URLSearchParams(window.location.search).has("player-controls")) {
    return <PlayerControlsWindow />;
  }

  const [view, setView] = useState<View>("library");
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toasts, notify, dismiss } = useNotifications();
  const {
    accounts, setAccounts,
    sources, setSources,
    files, setFiles,
    status,
    recent, setRecent,
    movieMetadata, setMovieMetadata,
    loadError,
    reloadFiles,
    refreshAll,
  } = useMediaLibrary();

  useEffect(() => {
    if (loadError) notify(loadError, "error");
  }, [loadError, notify]);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(60);
  const [query, setQuery] = useState("");
  const [scanningIds, setScanningIds] = useState<Set<string>>(new Set());
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [nowPlaying, setNowPlaying] = useState<MediaFile | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardEntry | null>(null);
  const [selectedWork, setSelectedWork] = useState<MediaWork | null>(null);
  const [selectedWorkMetadata, setSelectedWorkMetadata] = useState<MovieMetadata | null>(null);
  const [movieCategory, setMovieCategory] = useState<MovieCategory>("all");
  const [movieYear, setMovieYear] = useState("all");
  const [movieSort, setMovieSort] = useState<MovieSort>("title");
  const [musicSort, setMusicSort] = useState<MusicSort>("title-asc");

  const openGeneration = useRef(0);
  const contentScroll = useRef<HTMLDivElement>(null);
  useEffect(() => { contentScroll.current?.scrollTo({top:0, left:0}); }, [view, selectedAccountId]);

  // Keyboard shortcut: Escape to close modals
  useEffect(() => {
    const handleClose = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDialogOpen(false);
        setSelectedWork(null);
        setPendingDelete(null);
      }
    };
    window.addEventListener("keydown", handleClose);
    return () => window.removeEventListener("keydown", handleClose);
  }, []);


  // Reset pagination on filter or view change
  useEffect(() => {
    setPageSize(60);
  }, [query, view, movieCategory, movieYear, sourceFilter]);

  // Player state listener: keep nowPlaying synchronized with backend
  useEffect(() => {
    let unlistenStopped: (() => void) | undefined;
    let disposed = false;
    listen("nimbus-player-stopped", () => {
      setNowPlaying(null);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlistenStopped = dispose;
      })
      .catch(() => undefined);

    let activeId: string | null | undefined;
    const unsubPlayer = subscribePlayer((status) => {
      if (status.fileId === activeId) return;
      activeId = status.fileId;
      const requestedId = status.fileId;
      if (!status.fileId) {
        setNowPlaying(null);
      } else {
        void getCurrentPlayerFile().then((file) => {
          if (!disposed && file && activeId === requestedId) {
            setNowPlaying(file);

          }
        }).catch(() => { if (!disposed && activeId === requestedId) setNowPlaying(null); });
      }
    });

    return () => {
      disposed = true;
      unlistenStopped?.();
      unsubPlayer();
    };
  }, []);

  const { allMovieWorks, totalMovieCount, movieYears, movieShelves, scopedFiles } = 
    useMovieShelves(files, movieMetadata, sourceFilter, query, movieCategory, movieYear, movieSort);
  
  const { musicFiles, totalMusicCount, visibleMusicFiles } = 
    useMusicFiles(scopedFiles, musicSort, sources, accounts, query);

  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);

  // Play queue
  const playQueue = useMemo(() => {
    if (!nowPlaying) return [];
    if (nowPlaying.mediaKind === "movie") {
      return (
        allMovieWorks.find((work) => work.files.some((file) => file.id === nowPlaying.id))?.files ?? [
          nowPlaying,
        ]
      );
    }
    return musicFiles;
  }, [allMovieWorks, musicFiles, nowPlaying]);

  async function scanSource(source: MediaSource) {
    setScanningIds((prev) => new Set(prev).add(source.id));
    notify(`正在增量扫描 ${source.label}…`);
    try {
      const result = await scanMediaSource(source.id);
      await refreshAll();
      notify(`${result.truncated ? "部分扫描完成，原有索引已保留；请缩小目录后重试" : "扫描完成"}：${source.label} 索引 ${result.mediaFiles} 个${source.kind === "music" ? "音频" : "视频"}`, "success");
    } catch (cause) {
      notify(`扫描 ${source.label} 失败：${cause instanceof Error ? cause.message : String(cause)}`, "error");
    } finally {
      setScanningIds((prev) => {
        const next = new Set(prev);
        next.delete(source.id);
        return next;
      });
    }
  }

  async function openFile(file: MediaFile, fromStart = false) {
    const generation = ++openGeneration.current;
    setOpeningId(file.id);
    notify("");
    if (file.mediaKind === "music") {
      setNowPlaying(file);
    }
    try {
      await openNativePlayer(file.id, fromStart || file.mediaKind === "music");
      if (generation === openGeneration.current) {
        setNowPlaying(file);
        notify("");
        void refreshAll();
      }
    } catch (cause) {
      if (generation !== openGeneration.current) return;
      setNowPlaying(null);
      notify(`无法开始播放：${cause instanceof Error ? cause.message : String(cause)}`, "error");
    } finally {
      if (generation === openGeneration.current) setOpeningId(null);
    }
  }

  async function removeSource(source: MediaSource) {
    try {
      await removeMediaSource(source.id);
      await refreshAll();
      notify(`已移除 ${source.label}，存储源中的文件没有改动。`, "success");
    } catch (cause) {
      notify(`移除媒体目录失败：${cause instanceof Error ? cause.message : String(cause)}`, "error");
    }
  }

  async function removeCloudAccount(account: Account) {
    try {
      await removeAccount(account.id);
      setAccounts((current) => current.filter((item) => item.id !== account.id));
      setSources((current) => current.filter((source) => source.accountId !== account.id));
      setFiles((current) => current.filter((file) => file.accountId !== account.id));
      if (selectedAccountId === account.id) {
        setSelectedAccountId(null);
        setView("library");
      }
      notify(`已删除 ${account.label}，存储源中的文件没有改动。`, "success");
    } catch (cause) {
      notify(`删除云盘失败：${cause instanceof Error ? cause.message : String(cause)}`, "error");
    }
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    if (target.type === "account") await removeCloudAccount(target.item);
    else await removeSource(target.item);
  }

  const handleStartDrag = (e: React.MouseEvent) => {
    if (e.buttons === 1) {
      const target = e.target as HTMLElement;
      if (target.closest("button, input, select, textarea, a, .search, .no-drag")) return;
      void getCurrentWindow().startDragging();
    }
  };

  return (
    <main className={`app-shell ${nowPlaying?.mediaKind === "movie" ? "video-playing" : ""}`}>
      <aside className="sidebar">
        <div className="traffic-light-space" data-tauri-drag-region onMouseDown={handleStartDrag} />
        <div className="brand" data-tauri-drag-region onMouseDown={handleStartDrag}>
          <span className="brand-mark">
            <Cloud size={19} />
          </span>
          <span>Cove</span>
          <span className="alpha">ALPHA</span>
        </div>
        <nav>
          <p className="nav-label">个人空间</p>
          <button
            className={`nav-item ${view === "library" ? "active" : ""}`}
            onClick={() => setView("library")}
          >
            <Library size={18} />
            首页
          </button>
          <button className={`nav-item ${view === "files" || view === "storage" ? "active" : ""}`} onClick={() => setView("files")}><FolderOpen size={18}/>文件</button>
          <button
            className={`nav-item ${view === "movie" ? "active" : ""}`}
            onClick={() => {
              setSourceFilter(null);
              setView("movie");
            }}
          >
            <Film size={18} />
            影视
            <span className="nav-count">{totalMovieCount}</span>
          </button>
          <button
            className={`nav-item ${view === "music" ? "active" : ""}`}
            onClick={() => {
              setSourceFilter(null);
              setView("music");
            }}
          >
            <Music size={18} />
            音乐
            <span className="nav-count">{totalMusicCount}</span>
          </button>
          <button
            className={`nav-item ${view === "sources" ? "active" : ""}`}
            onClick={() => setView("sources")}
          >
            <FolderOpen size={18} />
            来源管理
          </button>

          <p className="nav-label storage-label">存储位置</p>
          {accounts.map((account) => (
            <div className="storage-row account-row" key={account.id}>
              <button
                className={`nav-item storage-name ${
                  view === "storage" && selectedAccountId === account.id ? "active" : ""
                }`}
                onClick={() => {
                  setSelectedAccountId(account.id);
                  setView("storage");
                }}
              >
                <FolderOpen size={18} />
                {account.label}
              </button>
              {account.provider !== "local" && (
                <button
                  className="delete-source-button"
                  title="删除云盘账号"
                  aria-label={`删除${account.label}`}
                  onClick={() => setPendingDelete({ type: "account", item: account })}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
          <button className="nav-item add-storage" onClick={() => setDialogOpen(true)}>
            <Plus size={17} />
            添加云盘
          </button>

          {sources.length > 0 && (
            <>
              <p className="nav-label storage-label">媒体目录</p>
              {sources.map((source) => (
                <div className="storage-row source-row" key={source.id}>
                  <button
                    className="nav-item storage-name"
                    onClick={() => {
                      setSourceFilter(source.id);
                      setView(source.kind);
                    }}
                  >
                    {source.kind === "movie" ? <Film size={18} /> : <Music size={18} />}
                    {source.label}
                  </button>
                  <button
                    className="scan-button"
                    title="增量扫描全部子文件夹"
                    disabled={scanningIds.has(source.id)}
                    onClick={() => void scanSource(source)}
                  >
                    {scanningIds.has(source.id) ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                  </button>
                  <button
                    className="delete-source-button"
                    title="移除本地媒体目录"
                    onClick={() => setPendingDelete({ type: "source", item: source })}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </>
          )}
        </nav>

        <div className="sidebar-footer">
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => setView("settings")}
          >
            <Settings size={18} />
            设置
          </button>
          <button
            className={`nav-item ${view === "help" ? "active" : ""}`}
            onClick={() => setView("help")}
          >
            <CircleHelp size={18} />
            帮助与反馈
          </button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar" data-tauri-drag-region onMouseDown={handleStartDrag}>
          <div className="search">
            <Search size={18} />
            <input
              aria-label="搜索媒体"
              placeholder={
                view === "movie"
                  ? "搜索片名、原名或演员…"
                  : view === "music"
                  ? "搜索歌曲名、文件夹或路径…"
                  : "搜索影音与存储位置…"
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                if (view !== "movie" && view !== "music" && event.target.value.trim()) {
                  setSourceFilter(null);
                  setView("search");
                }
              }}
            />
            {query && (
              <button
                type="button"
                className="icon-button search-clear"
                aria-label="清空搜索"
                title="清空搜索"
                onClick={() => setQuery("")}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "inherit",
                  opacity: 0.6,
                  padding: "4px",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <X size={15} />
              </button>
            )}
          </div>
          {!window.hasOwnProperty("__TAURI_INTERNALS__") && new URLSearchParams(window.location.search).has("demo") && <span className="space-demo-label">演示数据</span>}
          <button className="button secondary compact" onClick={() => setDialogOpen(true)}>
            <Plus size={17} />
            添加云盘
          </button>
        </header>

        <div className="content-scroll" ref={contentScroll}>
          {view === "files" ? <FilesView accounts={accounts} onBrowse={id => { setSelectedAccountId(id); setView("storage"); }} onAdd={() => setDialogOpen(true)}/> : view === "search" ? <SearchView query={query} files={files} accounts={accounts} sources={sources} onPlay={file => void openFile(file)} onBrowse={id=>{setSelectedAccountId(id);setView("storage");}}/> : view === "settings" ? (
            <SettingsView
              accounts={accounts}
              sources={sources}
              files={files}
              status={status}
              onClearMetadataCache={() => {
                void clearMetadataCache()
                  .then(() => {
                    setMovieMetadata({});
                    notify("元数据缓存已清理，下次打开作品会重新匹配", "success");
                  })
                  .catch((error) => notify(String(error), "error"));
              }}
              onRefreshStatus={() => {
                void refreshAll()
                  .then(() => notify("状态已刷新", "success"))
                  .catch((error) => notify(String(error), "error"));
              }}
            />
          ) : view === "help" ? (
            <HelpView />
          ) : view === "storage" && selectedAccount ? (
            <StorageBrowser
              key={selectedAccount.id}
              accounts={accounts}
              account={selectedAccount}
              sources={sources}
              clipboard={clipboard}
              onClipboardChange={setClipboard}
              onSourceAdded={(source) => {
                setSources((current) => [...current, source]);
              }}
              onSourceRemoved={async (source) => setPendingDelete({ type: "source", item: source })}
              onScanFinished={reloadFiles}
              onNotice={(msg) => notify(msg)}
              scanningIds={scanningIds}
              onTriggerScan={(source) => void scanSource(source)}
            />
          ) : view === "library" ? (
            <HomeView
              accounts={accounts}
              onFiles={() => setView("files")}
              onBrowse={id => { setSelectedAccountId(id); setView("storage"); }}
              files={files}
              sources={sources}
              recent={recent}
              onPlay={(file) => void openFile(file)}
              onMovies={() => {
                setSourceFilter(null);
                setView("movie");
              }}
              onMusic={() => {
                setSourceFilter(null);
                setView("music");
              }}
              onSources={() => setView("sources")}
            />
          ) : (
            <>
              <div className="section-heading">
                <div>
                  <p className="eyebrow">
                    {view === "sources"
                      ? "媒体来源"
                      : view === "music"
                      ? "聚合音乐库"
                      : "电影与电视剧"}
                  </p>
                  <h2>
                    {view === "sources"
                      ? sources.length
                        ? `${sources.length} 个媒体目录`
                        : "先选择要管理的文件夹"
                      : view === "movie"
                      ? `${movieShelves.length} 部作品`
                      : `${visibleMusicFiles.length} 个音频`}
                  </h2>
                </div>
                <span className="runtime-status">
                  {sourceFilter ? (
                    <button className="button secondary" onClick={() => setSourceFilter(null)}>
                      清除来源筛选
                    </button>
                  ) : (
                    "私人收藏 · 本机索引"
                  )}
                </span>
              </div>

              {view === "sources" ? (
                <SourcesView
                  sources={sources}
                  accounts={accounts}
                  scanningIds={scanningIds}
                  onScan={(source) => void scanSource(source)}
                  onBrowse={(accountId) => {
                    setSelectedAccountId(accountId);
                    setView("storage");
                  }}
                  onRemove={(source) => setPendingDelete({ type: "source", item: source })}
                />
              ) : view === "movie" ? (
                <MovieView
                  movieShelves={movieShelves}
                  accounts={accounts}
                  movieMetadata={movieMetadata}
                  movieCategory={movieCategory}
                  onMovieCategoryChange={setMovieCategory}
                  movieYear={movieYear}
                  onMovieYearChange={setMovieYear}
                  movieYears={movieYears}
                  movieSort={movieSort}
                  onMovieSortChange={setMovieSort}
                  pageSize={pageSize}
                  onLoadMore={() => setPageSize((v) => v + 60)}
                  openingId={openingId}
                  onMetadata={(metadata, workId) =>
                    setMovieMetadata((cur) =>
                      cur[workId] === metadata ? cur : { ...cur, [workId]: metadata }
                    )
                  }
                  onOpenWork={(work, metadata) => {
                    setSelectedWork(work);
                    setSelectedWorkMetadata(metadata);
                  }}
                  onResetFilters={() => {
                    setQuery("");
                    setMovieCategory("all");
                    setMovieYear("all");
                    setSourceFilter(null);
                  }}
                />
              ) : view === "music" ? (
                <MusicView
                  visibleFiles={visibleMusicFiles}
                  sources={sources}
                  accounts={accounts}
                  musicSort={musicSort}
                  onMusicSortChange={setMusicSort}
                  pageSize={pageSize}
                  onLoadMore={() => setPageSize((v) => v + 60)}
                  nowPlayingId={nowPlaying?.id}
                  openingId={openingId}
                  onPlayFile={(file) => void openFile(file)}
                  query={query}
                  onResetFilters={() => {
                    setQuery("");
                    setMusicSort("title-asc");
                    setSourceFilter(null);
                  }}
                />
              ) : null}
            </>
          )}

          <ToastContainer toasts={toasts} onDismiss={dismiss} />
        </div>
      </section>

      <AddAccountDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAdded={(account) => setAccounts((current) => [...current, account])}
      />

      <MovieDetailModal
        work={selectedWork}
        initialMetadata={selectedWorkMetadata}
        onClose={() => {
          setSelectedWork(null);
          setSelectedWorkMetadata(null);
        }}
        onPlayFile={(file) => void openFile(file)}
        onNotice={(msg) => notify(msg)}
        onMetadataUpdate={(workId, metadata) =>
          setMovieMetadata((cur) => ({ ...cur, [workId]: metadata }))
        }
      />

      <ConfirmDeleteDialog
        target={pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />

      {nowPlaying?.mediaKind === "movie" && <div className="embedded-player-backdrop" />}

      <MusicPlayerBar
        nowPlaying={nowPlaying}
        playQueue={playQueue}
        openingId={openingId}
        onOpenFile={openFile}
        onStop={() => setNowPlaying(null)}
      />
    </main>
  );
}
