import { forwardRef, useRef, useState } from "react";
import { CalendarPlus, Clapperboard, FileText, GraduationCap, History, House, ListMusic, LoaderCircle, Music, PanelLeft, Plus, TrendingUp } from "lucide-react";
import { showContextMenu } from "../lib/native";
import type { Account, MediaFile, MediaSource, Playlist, SmartListKind } from "../lib/nimbus";
import { SMART_LISTS } from "../views/SmartPlaylistView";
import { usePlayer } from "../player/PlayerProvider";
import { SearchField } from "../ui/controls";
import { providerIcon } from "../ui/glyphs";
import { useTopmostEscape } from "../ui/Sheet";
import { sidebarKey, type Route } from "./navigation";
import { SONGS_DRAG_TYPE } from "./playlistActions";
import { routeForSource, SOURCE_KINDS } from "./sourceKinds";
import type { Library } from "./useLibrary";

type Props = {
  route: Route;
  library: Library;
  query: string;
  onQuery: (value: string) => void;
  onSearchKey: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onNavigate: (route: Route) => void;
  onAddStorage: () => void;
  onRemoveAccount: (account: Account) => void;
  onRemoveSource: (source: MediaSource) => void;
  onNewPlaylist: () => void;
  onDeletePlaylist: (playlist: Playlist) => void;
  /** The playlist whose name is being edited in place (a new one starts this way). */
  editingPlaylist: string | null;
  onEditPlaylist: (id: string | null) => void;
  onWindowMouseDown: (event: React.MouseEvent) => void;
  onToggleSidebar: () => void;
};

/** The automatic playlists show only once they hold songs. */
const SMART_ICONS: Record<SmartListKind, typeof History> = { recentlyAdded: CalendarPlus, mostPlayed: TrendingUp, recentlyPlayed: History };

/** In-place name field, as when naming a new playlist in Music. */
function RenameField({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  // Escape, Return and the blur that follows them must finish the edit only once.
  const finished = useRef(false);
  const finish = (name: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(name);
  };
  useTopmostEscape(true, () => finish(null));
  return (
    <div className="sidebar-item editing">
      <ListMusic size={16} />
      <input
        className="sidebar-rename"
        aria-label="播放列表名称"
        value={value}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(value);
          }
        }}
        onBlur={() => finish(value)}
      />
    </div>
  );
}

function draggedSongs(event: React.DragEvent, library: Library): MediaFile[] {
  try {
    const ids: unknown = JSON.parse(event.dataTransfer.getData(SONGS_DRAG_TYPE) || "[]");
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => library.filesById.get(String(id))).filter((file): file is MediaFile => !!file);
  } catch {
    return [];
  }
}

/** One row per destination: library, storage locations, media folders. Everything else lives in menus. */
export const Sidebar = forwardRef<HTMLInputElement, Props>(function Sidebar(
  {
    route,
    library,
    query,
    onQuery,
    onSearchKey,
    onNavigate,
    onAddStorage,
    onRemoveAccount,
    onRemoveSource,
    onNewPlaylist,
    onDeletePlaylist,
    editingPlaylist,
    onEditPlaylist,
    onWindowMouseDown,
    onToggleSidebar,
  },
  searchRef,
) {
  const player = usePlayer();
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const active = sidebarKey(route);
  const current = (key: string) => (active === key ? "page" : undefined);
  const songsOf = (playlist: Playlist) =>
    playlist.fileIds.map((id) => library.filesById.get(id)).filter((file): file is MediaFile => file?.mediaKind === "music");

  return (
    <aside className="sidebar" aria-label="边栏">
      <div className="sidebar-header" data-tauri-drag-region onMouseDown={onWindowMouseDown}>
        <button className="icon-btn" title="隐藏边栏 (⌃⌘S)" aria-label="隐藏边栏" onClick={onToggleSidebar}>
          <PanelLeft size={17} />
        </button>
      </div>
      <div className="sidebar-search">
        <SearchField ref={searchRef} value={query} onChange={onQuery} onKeyDown={onSearchKey} placeholder="搜索" ariaLabel="搜索资料库" />
      </div>
      <nav className="sidebar-scroll">
        <section className="sidebar-section">
          <h2 className="sidebar-heading">
            <span>资料库</span>
          </h2>
          <button className="sidebar-item" aria-current={current("home")} onClick={() => onNavigate({ name: "home" })}>
            <House size={16} />
            <span className="label">首页</span>
          </button>
          <button className="sidebar-item" aria-current={current("movies")} onClick={() => onNavigate({ name: "movies" })}>
            <Clapperboard size={16} />
            <span className="label">影视</span>
            <span className="trailing">{library.works.length || ""}</span>
          </button>
          <button className="sidebar-item" aria-current={current("music")} onClick={() => onNavigate({ name: "music" })}>
            <Music size={16} />
            <span className="label">音乐</span>
            <span className="trailing">{library.songs.length || ""}</span>
          </button>
          <button className="sidebar-item" aria-current={current("documents")} onClick={() => onNavigate({ name: "documents" })}>
            <FileText size={16} />
            <span className="label">文档</span>
            <span className="trailing">{library.documents.length || ""}</span>
          </button>
          <button className="sidebar-item" aria-current={current("courses")} onClick={() => onNavigate({ name: "courses" })}>
            <GraduationCap size={16} />
            <span className="label">课程</span>
            <span className="trailing">{library.courses.length || ""}</span>
          </button>
        </section>

        {(library.songs.length > 0 || library.playlists.length > 0) && (
          <section className="sidebar-section">
            <h2 className="sidebar-heading">
              <span>播放列表</span>
              <button className="icon-btn small" title="新建播放列表" aria-label="新建播放列表" onClick={onNewPlaylist}>
                <Plus size={13} />
              </button>
            </h2>
            {SMART_LISTS.filter(({ kind }) => library.smartLists[kind].length > 0).map(({ kind, title }) => {
              const Icon = SMART_ICONS[kind];
              return (
                <button
                  key={kind}
                  className="sidebar-item"
                  aria-current={current(`smart:${kind}`)}
                  onClick={() => onNavigate({ name: "smart", list: kind })}
                >
                  <Icon size={16} />
                  <span className="label">{title}</span>
                </button>
              );
            })}
            {library.playlists.map((playlist) => {
              if (editingPlaylist === playlist.id) {
                return (
                  <RenameField
                    key={playlist.id}
                    initial={playlist.name}
                    onDone={(name) => {
                      onEditPlaylist(null);
                      if (name !== null) void library.renamePlaylist(playlist, name);
                    }}
                  />
                );
              }
              const open = () => onNavigate({ name: "playlist", id: playlist.id });
              const songs = songsOf(playlist);
              return (
                <button
                  key={playlist.id}
                  className={`sidebar-item ${dropTarget === playlist.id ? "drop-target" : ""}`}
                  aria-current={current(`playlist:${playlist.id}`)}
                  title={playlist.name}
                  onClick={open}
                  onDoubleClick={() => onEditPlaylist(playlist.id)}
                  onContextMenu={(event) =>
                    void showContextMenu(event, [
                      { label: "播放", enabled: songs.length > 0, action: () => void player.play(songs[0], { queue: songs, fromStart: true }) },
                      { label: "随机播放", enabled: songs.length > 1, action: () => player.playShuffled(songs) },
                      "separator",
                      { label: "重命名", action: () => onEditPlaylist(playlist.id) },
                      { label: "删除播放列表…", destructive: true, action: () => onDeletePlaylist(playlist) },
                    ])
                  }
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes(SONGS_DRAG_TYPE)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    setDropTarget(playlist.id);
                  }}
                  onDragLeave={() => setDropTarget((value) => (value === playlist.id ? null : value))}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDropTarget(null);
                    const files = draggedSongs(event, library);
                    if (files.length) void library.addToPlaylist(playlist, files);
                  }}
                >
                  <ListMusic size={16} />
                  <span className="label">{playlist.name}</span>
                  <span className="trailing">{songs.length || ""}</span>
                </button>
              );
            })}
          </section>
        )}

        <section className="sidebar-section">
          <h2 className="sidebar-heading">
            <span>位置</span>
            <button className="icon-btn small" title="添加存储…" aria-label="添加存储" onClick={onAddStorage}>
              <Plus size={13} />
            </button>
          </h2>
          {library.accounts.map((account) => {
            const Icon = providerIcon(account.provider);
            const open = () => onNavigate({ name: "storage", accountId: account.id, path: "/" });
            return (
              <button
                key={account.id}
                className="sidebar-item"
                aria-current={current(`account:${account.id}`)}
                title={account.label}
                onClick={open}
                onContextMenu={(event) =>
                  void showContextMenu(event, [
                    { label: "打开", action: open },
                    ...(account.provider !== "local"
                      ? (["separator", { label: `移除“${account.label}”…`, destructive: true, action: () => onRemoveAccount(account) }] as const)
                      : []),
                  ])
                }
              >
                <Icon size={16} />
                <span className="label">{account.label}</span>
              </button>
            );
          })}
        </section>

        {library.sources.length > 0 && (
          <section className="sidebar-section">
            <h2 className="sidebar-heading">
              <span>媒体文件夹</span>
            </h2>
            {library.sources.map((source) => {
              const scanning = library.scanningIds.has(source.id);
              const open = () =>
                onNavigate(routeForSource(source));
              return (
                <button
                  key={source.id}
                  className="sidebar-item"
                  aria-current={current(`source:${source.id}`)}
                  title={`${source.label}\n${source.remoteRoot}`}
                  onClick={open}
                  onContextMenu={(event) =>
                    void showContextMenu(event, [
                      { label: "显示", action: open },
                      { label: "在文件中显示", action: () => onNavigate({ name: "storage", accountId: source.accountId, path: source.remoteRoot }) },
                      { label: "重新扫描", enabled: !scanning, action: () => void library.scanSource(source) },
                      "separator",
                      { label: `移除“${source.label}”…`, destructive: true, action: () => onRemoveSource(source) },
                    ])
                  }
                >
                  {(() => {
                    const Icon = SOURCE_KINDS[source.kind].icon;
                    return <Icon size={16} />;
                  })()}
                  <span className="label">{source.label}</span>
                  {scanning && (
                    <span className="trailing">
                      <LoaderCircle className="spin" size={12} aria-label="正在扫描" />
                    </span>
                  )}
                </button>
              );
            })}
          </section>
        )}
      </nav>
    </aside>
  );
});
