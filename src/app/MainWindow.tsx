import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { workProgress, type MediaWork } from "../lib/media";
import { isEditableTarget, isTauri, onMenuAction } from "../lib/native";
import { demoEnabled, type Account, type MediaFile, type MediaSource, type Playlist } from "../lib/nimbus";
import { PlayerCenter, PlayerTools } from "../player/MiniPlayer";
import { NowPlaying } from "../player/NowPlaying";
import { PlayerPanel } from "../player/PlayerPanel";
import { PlayerProvider, usePlayer } from "../player/PlayerProvider";
import { Alert, type AlertRequest } from "../ui/Alert";
import { EmptyState } from "../ui/controls";
import { MenuHost } from "../ui/MenuHost";
import { isModalOpen } from "../ui/Sheet";
import { Toasts, useToasts, type Notify } from "../ui/Toasts";
import { AddStorageSheet } from "../views/AddStorageSheet";
import { HelpView } from "../views/HelpView";
import { HomeView } from "../views/HomeView";
import { MovieDetailSheet } from "../views/MovieDetailSheet";
import { DocumentsView } from "../views/DocumentsView";
import { MoviesView } from "../views/MoviesView";
import { MusicView } from "../views/MusicView";
import { PlaylistView } from "../views/PlaylistView";
import { SearchView } from "../views/SearchView";
import { SettingsView } from "../views/SettingsView";
import { StorageView, type ClipboardEntry } from "../views/StorageView";
import {
  canGoBack,
  canGoForward,
  currentRoute,
  goBack,
  goForward,
  initialHistory,
  navigate as push,
  pruneHistory,
  type History,
  type Route,
} from "./navigation";
import { PlaylistActionsContext, type PlaylistActions } from "./playlistActions";
import { Sidebar } from "./Sidebar";
import { useLibrary, type Library } from "./useLibrary";

const INTERACTIVE = "button, input, select, textarea, a, [role='button'], [role='slider'], .no-drag";

/** Drag the window from empty toolbar space; double-click zooms, as in AppKit. */
function windowMouseDown(event: React.MouseEvent) {
  if (event.button !== 0 || !isTauri() || (event.target as Element).closest(INTERACTIVE)) return;
  const window = getCurrentWindow();
  if (event.detail === 2) void window.toggleMaximize().catch(() => undefined);
  else void window.startDragging().catch(() => undefined);
}

export function MainWindow() {
  const { toasts, notify, dismiss } = useToasts();
  const library = useLibrary(notify);
  return (
    <PlayerProvider
      notify={notify}
      onPlaybackStarted={library.refreshRecent}
      songs={library.songs}
      recent={library.recent}
      loaded={library.loaded}
    >
      <Shell library={library} notify={notify} />
      <Toasts toasts={toasts} onDismiss={dismiss} />
      <MenuHost />
    </PlayerProvider>
  );
}

function initialSidebar() {
  try {
    return localStorage.getItem("cove-sidebar") !== "hidden";
  } catch {
    return true;
  }
}

function Shell({ library, notify }: { library: Library; notify: Notify }) {
  const player = usePlayer();
  const [history, setHistory] = useState<History>(initialHistory);
  const [sidebar, setSidebar] = useState(initialSidebar);
  const [query, setQuery] = useState("");
  const [clipboard, setClipboard] = useState<ClipboardEntry | null>(null);
  const [addingStorage, setAddingStorage] = useState(false);
  const [alert, setAlert] = useState<AlertRequest | null>(null);
  const [detail, setDetail] = useState<MediaWork | null>(null);
  const [editingPlaylist, setEditingPlaylist] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<number, number>());
  const returnFromSearch = useRef<History | null>(null);
  const route = currentRoute(history);

  const historyRef = useRef(history);
  historyRef.current = history;

  /** Move through history, remembering where the page was scrolled. */
  const moveTo = useCallback((result: History) => {
    const current = historyRef.current;
    if (result === current) return;
    if (content.current) scrollPositions.current.set(current.index, content.current.scrollTop);
    historyRef.current = result;
    setHistory(result);
  }, []);

  // Choosing any destination leaves Now Playing, as in Music.
  const { setFullScreen } = player;
  const navigate = useCallback(
    (next: Route, options?: { replace?: boolean }) => {
      setFullScreen(false);
      const result = push(historyRef.current, next, options);
      if (result !== historyRef.current) scrollPositions.current.delete(result.index);
      moveTo(result);
      if (next.name !== "search") {
        setQuery("");
        returnFromSearch.current = null;
      }
    },
    [moveTo, setFullScreen],
  );

  // New pages start at the top; back and forward return to where you were.
  useEffect(() => {
    const top = scrollPositions.current.get(history.index) ?? 0;
    const frame = requestAnimationFrame(() => content.current?.scrollTo({ top }));
    return () => cancelAnimationFrame(frame);
  }, [history]);

  // Back and Forward to a search bring its query back into the search field.
  const travel = useCallback(
    (result: History) => {
      setFullScreen(false);
      moveTo(result);
      const destination = currentRoute(result);
      setQuery(destination.name === "search" ? destination.query : "");
    },
    [moveTo, setFullScreen],
  );
  const back = useCallback(() => travel(goBack(historyRef.current)), [travel]);
  const forward = useCallback(() => travel(goForward(historyRef.current)), [travel]);

  const toggleSidebar = useCallback(() => {
    setSidebar((value) => {
      try {
        localStorage.setItem("cove-sidebar", value ? "hidden" : "visible");
      } catch {
        // Preferences are best effort.
      }
      return !value;
    });
  }, []);

  const onQuery = (value: string) => {
    setQuery(value);
    const current = historyRef.current;
    const searching = currentRoute(current).name === "search";
    if (value.trim()) {
      // Typing shows the results, even from Now Playing; each keystroke refines the same page.
      if (!searching) returnFromSearch.current = current;
      navigate({ name: "search", query: value }, { replace: searching });
    } else if (searching && returnFromSearch.current) {
      moveTo(returnFromSearch.current);
      returnFromSearch.current = null;
    } else if (searching) {
      moveTo(push(current, { name: "search", query: "" }, { replace: true }));
    }
  };

  const focusSearch = useCallback(() => {
    if (!sidebar) toggleSidebar();
    requestAnimationFrame(() => searchInput.current?.select());
  }, [sidebar, toggleSidebar]);

  const confirmRemoveAccount = useCallback(
    (account: Account) =>
      setAlert({
        title: `移除“${account.label}”？`,
        message:
          "Cove 会移除这个账号、它的媒体文件夹与本地索引，包括播放进度和播放列表中的条目。存储中的文件不会被删除。如果只是登录失效，请在“设置”中改用“重新连接…”。",
        icon: <Trash2 size={28} color="var(--red)" />,
        confirmLabel: "移除",
        destructive: true,
        onConfirm: async () => {
          if (await library.removeAccount(account)) {
            moveTo(pruneHistory(historyRef.current, (item) => item.name === "storage" && item.accountId === account.id));
          }
        },
      }),
    [library, moveTo],
  );

  const confirmRemoveSource = useCallback(
    (source: MediaSource) =>
      setAlert({
        title: `移除“${source.label}”？`,
        message: `其中的${source.kind === "movie" ? "影片与剧集" : source.kind === "music" ? "歌曲" : "文档"}会从资料库中移除。存储中的文件不会被删除。`,
        icon: <Trash2 size={28} color="var(--red)" />,
        confirmLabel: "移除",
        destructive: true,
        onConfirm: async () => {
          if (!(await library.removeSource(source))) return;
          moveTo(
            pruneHistory(
              historyRef.current,
              (item) => (item.name === "movies" || item.name === "music" || item.name === "documents") && item.sourceId === source.id,
            ),
          );
        },
      }),
    [library, moveTo],
  );

  const newPlaylist = useCallback(
    async (songs: MediaFile[] = []) => {
      const created = await library.createPlaylist(songs);
      if (!created) return;
      if (!sidebar) toggleSidebar();
      navigate({ name: "playlist", id: created.id });
      setEditingPlaylist(created.id);
    },
    [library, navigate, sidebar, toggleSidebar],
  );

  const confirmDeletePlaylist = useCallback(
    (playlist: Playlist) =>
      setAlert({
        title: `删除“${playlist.name}”？`,
        message: "只会删除这个播放列表。其中的歌曲仍保留在资料库和存储中。",
        icon: <Trash2 size={28} color="var(--red)" />,
        confirmLabel: "删除",
        destructive: true,
        onConfirm: async () => {
          if (await library.deletePlaylist(playlist)) {
            moveTo(pruneHistory(historyRef.current, (item) => item.name === "playlist" && item.id === playlist.id));
          }
        },
      }),
    [library, moveTo],
  );

  const playlistActions = useMemo<PlaylistActions>(
    () => ({
      playlists: library.playlists,
      add: (playlist, songs) => void library.addToPlaylist(playlist, songs),
      create: (songs) => void newPlaylist(songs),
    }),
    [library, newPlaylist],
  );

  // Menu bar commands (and their keyboard equivalents in the browser preview).
  const command = useRef<(id: string) => void>(() => undefined);
  command.current = (id: string) => {
    const music = !!player.nowPlaying && !player.isVideo;
    switch (id) {
      case "cove.settings":
        return navigate({ name: "settings" });
      case "cove.help":
        return navigate({ name: "help" });
      case "cove.add-storage":
        return setAddingStorage(true);
      case "cove.new-playlist":
        return void newPlaylist();
      case "cove.find":
        return focusSearch();
      case "cove.go.home":
        return navigate({ name: "home" });
      case "cove.go.movies":
        return navigate({ name: "movies" });
      case "cove.go.music":
        return navigate({ name: "music" });
      case "cove.go.documents":
        return navigate({ name: "documents" });
      case "cove.back":
        return back();
      case "cove.forward":
        return forward();
      case "cove.toggle-sidebar":
        return toggleSidebar();
      case "cove.show-lyrics":
        return player.togglePanel("lyrics");
      case "cove.show-queue":
        return player.togglePanel("queue");
    }
    if (!music) return;
    switch (id) {
      case "cove.play-pause":
        return player.togglePlay();
      case "cove.stop":
        return player.stop();
      case "cove.next":
        return player.next();
      case "cove.previous":
        return player.previous();
      case "cove.volume-up":
        return player.changeVolume(10);
      case "cove.volume-down":
        return player.changeVolume(-10);
      case "cove.shuffle":
        return player.toggleShuffle();
      case "cove.repeat":
        return player.cycleRepeat();
    }
  };

  useEffect(() => onMenuAction((id) => command.current(id)), []);

  // Browser layout fixture (tests/music-layout.html): start a song with long lyrics.
  const fixtureStarted = useRef(false);
  useEffect(() => {
    if (fixtureStarted.current || !demoEnabled || !library.songs.length) return;
    if (new URLSearchParams(window.location.search).get("fixture") !== "music") return;
    fixtureStarted.current = true;
    void player.play(library.songs[0], { queue: library.songs.slice(0, 12), fromStart: true });
    player.setPanel("lyrics");
  }, [library.songs, player]);

  useEffect(() => {
    const keys: Record<string, string> = {
      f: "cove.find",
      ",": "cove.settings",
      n: "cove.add-storage",
      "1": "cove.go.home",
      "2": "cove.go.movies",
      "3": "cove.go.music",
      "4": "cove.go.documents",
      "[": "cove.back",
      "]": "cove.forward",
      ArrowRight: "cove.next",
      ArrowLeft: "cove.previous",
      ArrowUp: "cove.volume-up",
      ArrowDown: "cove.volume-down",
    };
    const onKey = (event: KeyboardEvent) => {
      // A focused list or control already used the key (Space opening a document, ⌘↑ in Files).
      if (player.isVideo || event.defaultPrevented) return;
      // In the native app these arrive through the menu bar instead.
      if (!isTauri() && event.metaKey && !event.altKey && !event.ctrlKey && keys[event.key]) {
        if (isEditableTarget(event.target) && event.key.startsWith("Arrow")) return;
        event.preventDefault();
        command.current(keys[event.key]);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isModalOpen() || isEditableTarget(event.target)) return;
      if (event.code === "Space" && !(event.target instanceof HTMLButtonElement) && player.nowPlaying && !player.isVideo) {
        event.preventDefault();
        player.togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player]);

  const account = route.name === "storage" ? library.accounts.find((item) => item.id === route.accountId) : undefined;

  const page = (() => {
    switch (route.name) {
      case "home":
        return <HomeView library={library} notify={notify} onNavigate={navigate} onOpenWork={setDetail} onAddStorage={() => setAddingStorage(true)} />;
      case "storage":
        return account ? (
          <StorageView
            key={account.id}
            library={library}
            account={account}
            path={route.path}
            clipboard={clipboard}
            onClipboard={setClipboard}
            onNavigate={navigate}
            onRemoveSource={confirmRemoveSource}
            notify={notify}
          />
        ) : (
          <div className="page">
            <EmptyState title={library.loaded ? "这个位置已不可用" : "正在载入…"} message={library.loaded ? "它可能已被移除。" : undefined} />
          </div>
        );
      case "movies":
        return <MoviesView key={route.sourceId ?? "all"} library={library} sourceId={route.sourceId} onOpenWork={setDetail} onNavigate={navigate} />;
      case "music":
        return <MusicView key={route.sourceId ?? "all"} library={library} sourceId={route.sourceId} onNavigate={navigate} />;
      case "playlist":
        return <PlaylistView key={route.id} library={library} playlistId={route.id} onNavigate={navigate} />;
      case "documents":
        return <DocumentsView key={route.sourceId ?? "all"} library={library} sourceId={route.sourceId} onNavigate={navigate} notify={notify} />;
      case "search":
        return <SearchView key={route.query.trim()} query={route.query} library={library} notify={notify} onNavigate={navigate} onOpenWork={setDetail} />;
      case "settings":
        return (
          <SettingsView
            library={library}
            notify={notify}
            onNavigate={navigate}
            onAddStorage={() => setAddingStorage(true)}
            onRemoveAccount={confirmRemoveAccount}
            onRemoveSource={confirmRemoveSource}
          />
        );
      case "help":
        return <HelpView />;
    }
  })();

  return (
    <div
      className="window"
      data-sidebar={sidebar ? "visible" : "hidden"}
      data-video={player.isVideo ? "" : undefined}
      style={{ "--panel-width": player.panel && !player.fullScreen ? "320px" : "0px" } as CSSProperties}
    >
      <Sidebar
        ref={searchInput}
        route={route}
        library={library}
        query={query}
        onQuery={onQuery}
        onSearchKey={(event) => {
          // Enter shows the results, also when Now Playing covers them.
          if (event.key === "Enter" && query.trim()) navigate({ name: "search", query });
        }}
        onNavigate={navigate}
        onAddStorage={() => setAddingStorage(true)}
        onRemoveAccount={confirmRemoveAccount}
        onRemoveSource={confirmRemoveSource}
        onNewPlaylist={() => void newPlaylist()}
        onDeletePlaylist={confirmDeletePlaylist}
        editingPlaylist={editingPlaylist}
        onEditPlaylist={setEditingPlaylist}
        onWindowMouseDown={windowMouseDown}
      />
      <div className="main">
        <header className="toolbar" data-tauri-drag-region onMouseDown={windowMouseDown}>
          <div className="toolbar-group">
            <button className="icon-btn" title="返回 (⌘[)" aria-label="返回" disabled={!canGoBack(history)} onClick={back}>
              <ChevronLeft size={19} />
            </button>
            <button className="icon-btn" title="前进 (⌘])" aria-label="前进" disabled={!canGoForward(history)} onClick={forward}>
              <ChevronRight size={19} />
            </button>
          </div>
          <PlayerCenter />
          <div className="toolbar-group trailing">
            <PlayerTools />
          </div>
        </header>
        <div className="main-body">
          <main ref={content} className={`content ${route.name === "storage" ? "flush" : ""}`}>
            <PlaylistActionsContext.Provider value={playlistActions}>{page}</PlaylistActionsContext.Provider>
          </main>
          <PlayerPanel />
          <NowPlaying />
        </div>
      </div>

      {addingStorage && (
        <AddStorageSheet
          onClose={() => setAddingStorage(false)}
          onAdded={(added) => {
            library.addAccount(added);
            notify(`已连接“${added.label}”`, "success");
            navigate({ name: "storage", accountId: added.id, path: "/" });
          }}
        />
      )}
      {detail && (
        <MovieDetailSheet
          key={detail.id}
          work={detail}
          metadata={library.movieMetadata[detail.id]}
          onClose={() => setDetail(null)}
          onMetadata={library.setMovieMetadata}
          onNavigate={navigate}
          notify={notify}
          progress={workProgress(detail, library.savedById)}
          onMark={library.markWatched}
        />
      )}
      {alert && <Alert request={alert} onClose={() => setAlert(null)} />}
    </div>
  );
}
