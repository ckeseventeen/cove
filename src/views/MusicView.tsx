import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AudioLines, ChevronDown, ChevronUp, LoaderCircle, Music2, Play, Shuffle } from "lucide-react";
import type { Route } from "../app/navigation";
import { SONGS_DRAG_TYPE, usePlaylistActions } from "../app/playlistActions";
import type { Library } from "../app/useLibrary";
import { formatBytes, plural } from "../lib/format";
import { compareAlbumOrder, containingFolder, musicFolderOf, songParts } from "../lib/media";
import { showContextMenu } from "../lib/native";
import type { MediaFile } from "../lib/nimbus";
import { extensionOf } from "../lib/storage";
import { usePlayer } from "../player/PlayerProvider";
import { usePlayerStatus } from "../player/statusStore";
import { EmptyState, useIncrementalCount } from "../ui/controls";

type SongSortField = "title" | "artist" | "folder" | "size";
export type SongSort = { field: SongSortField; ascending: boolean };

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function loadSort(): SongSort {
  try {
    const saved = JSON.parse(localStorage.getItem("cove-music-sort-v2") ?? "null");
    if (saved && ["title", "artist", "folder", "size"].includes(saved.field)) return { field: saved.field, ascending: !!saved.ascending };
  } catch {
    // Fall back to the default order.
  }
  return { field: "title", ascending: true };
}

type Props = { library: Library; sourceId?: string; onNavigate: (route: Route) => void };

export function MusicView({ library, sourceId, onNavigate }: Props) {
  const player = usePlayer();
  const [sort, setSort] = useState<SongSort>(loadSort);
  const source = library.sources.find((item) => item.id === sourceId);

  const changeSort = (field: SongSortField) => {
    const next = { field, ascending: sort.field === field ? !sort.ascending : field !== "size" };
    setSort(next);
    try {
      localStorage.setItem("cove-music-sort-v2", JSON.stringify(next));
    } catch {
      // Preferences are best effort.
    }
  };

  const songs = useMemo(() => {
    const scoped = sourceId
      ? library.songs.filter((file) => file.sourceIds?.includes(sourceId) || file.sourceId === sourceId)
      : library.songs;
    const key = (file: MediaFile) => {
      if (sort.field === "artist") return songParts(file).artist || "\uffff";
      if (sort.field === "folder") return musicFolderOf(file);
      return songParts(file).title;
    };
    const direction = sort.ascending ? 1 : -1;
    return [...scoped].sort(
      (left, right) =>
        direction *
        (sort.field === "size"
          ? left.size - right.size
          : collator.compare(key(left), key(right)) ||
            // Albums play in track order.
            (sort.field === "folder" ? compareAlbumOrder(left, right) : collator.compare(songParts(left).title, songParts(right).title))),
    );
  }, [library.songs, sort, sourceId]);

  return (
    <div className="page">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">{source?.label ?? "音乐"}</h1>
          <p className="page-subtitle">
            {plural(songs.length, "首歌曲")}
            {source && (
              <>
                {" · "}
                <button className="btn plain inline" onClick={() => onNavigate({ name: "music" })}>
                  显示全部音乐
                </button>
              </>
            )}
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn prominent large"
            disabled={!songs.length}
            onClick={() => void player.play(songs[0], { queue: songs, fromStart: true })}
          >
            <Play size={12} fill="currentColor" strokeWidth={0} />
            播放
          </button>
          <button className="btn large" disabled={songs.length < 2} onClick={() => player.playShuffled(songs)}>
            <Shuffle size={13} />
            随机播放
          </button>
        </div>
      </header>
      {songs.length ? (
        <SongTable
          songs={songs}
          onNavigate={onNavigate}
          resetKey={`${sort.field}|${sort.ascending}|${sourceId}`}
          sort={sort}
          onSort={changeSort}
        />
      ) : (
        <EmptyState
          icon={<Music2 size={44} strokeWidth={1.3} />}
          title="音乐资料库是空的"
          message="在左侧“位置”中打开存放歌曲的文件夹，选择“添加到资料库”。"
        >
          <button className="btn" onClick={() => onNavigate({ name: "storage", accountId: "local", path: "/" })}>
            打开本地磁盘
          </button>
        </EmptyState>
      )}
    </div>
  );
}

/** Songs being dragged inside this window, so a list can tell its own rows apart from a drop elsewhere. */
let draggingSongs: { ids: string[]; from: string } | null = null;

/** WebKit snapshots the drag image where it is drawn, so it is placed under the pointer for one frame. */
function dragBadge(count: number, x: number, y: number) {
  const badge = document.createElement("div");
  badge.className = "drag-badge";
  badge.style.left = `${x + 8}px`;
  badge.style.top = `${y + 8}px`;
  badge.textContent = count === 1 ? "1 首歌曲" : `${count} 首歌曲`;
  document.body.append(badge);
  window.setTimeout(() => badge.remove(), 0);
  return badge;
}

/**
 * Songs list with Music.app semantics: click selects (⌘ and ⇧ extend), double-click or Return plays,
 * songs drag onto a playlist in the sidebar. Inside a playlist, rows also drag to reorder.
 */
export function SongTable({
  songs,
  onNavigate,
  resetKey,
  limit,
  sort,
  onSort,
  playlistId,
  onRemove,
  onReorder,
}: {
  songs: MediaFile[];
  onNavigate: (route: Route) => void;
  resetKey: string;
  limit?: number;
  sort?: SongSort;
  onSort?: (field: SongSortField) => void;
  /** Set when the list is a playlist: it is left out of "Add to Playlist". */
  playlistId?: string;
  onRemove?: (files: MediaFile[]) => void;
  onReorder?: (ids: string[], beforeId: string | null) => void;
}) {
  const player = usePlayer();
  const playlists = usePlaylistActions();
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const anchor = useRef<string | null>(null);
  const table = useRef<HTMLDivElement>(null);
  const { count, sentinel } = useIncrementalCount(limit ?? songs.length, 150, resetKey);
  const visible = songs.slice(0, limit ? Math.min(limit, count) : count);
  const currentId = !player.isVideo ? player.nowPlaying?.id : undefined;
  const playing = usePlayerStatus((status) => !!currentId && status.fileId === currentId && !status.paused);

  useEffect(() => {
    table.current?.querySelector(`[data-id="${CSS.escape(cursor ?? "")}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Forget songs that left the list (removed from a playlist, or a new search).
  useEffect(() => {
    setSelection((current) => {
      const ids = new Set(songs.map((file) => file.id));
      const kept = [...current].filter((id) => ids.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [songs]);

  const play = (file: MediaFile) => void player.play(file, { queue: songs, fromStart: true });
  const selectOnly = (id: string) => {
    setSelection(new Set([id]));
    setCursor(id);
    anchor.current = id;
  };
  const selectRange = (id: string) => {
    const from = visible.findIndex((file) => file.id === anchor.current);
    const to = visible.findIndex((file) => file.id === id);
    if (from < 0 || to < 0) return selectOnly(id);
    const [low, high] = from < to ? [from, to] : [to, from];
    setSelection(new Set(visible.slice(low, high + 1).map((file) => file.id)));
    setCursor(id);
  };
  const selectedSongs = (ids: ReadonlySet<string> = selection) => songs.filter((file) => ids.has(file.id));

  const header = (field: SongSortField, label: string, extra = "") => {
    if (!onSort) return <span className={`th ${extra}`}>{label}</span>;
    const active = sort?.field === field;
    return (
      <button className={`th ${extra} ${active ? "sorted" : ""}`} onClick={() => onSort(field)}>
        {label}
        {active && (sort?.ascending ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </button>
    );
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = visible.findIndex((file) => file.id === cursor);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
      if (!next) return;
      if (event.shiftKey && anchor.current) selectRange(next.id);
      else selectOnly(next.id);
    } else if (event.key === "Enter" && index >= 0) {
      event.preventDefault();
      play(visible[index]);
    } else if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      setSelection(new Set(songs.map((file) => file.id)));
    } else if ((event.key === "Backspace" || event.key === "Delete") && onRemove && selection.size) {
      event.preventDefault();
      onRemove(selectedSongs());
    }
  };

  const onRowMouseDown = (event: React.MouseEvent, file: MediaFile) => {
    if (event.button !== 0) return;
    if (event.metaKey) {
      const next = new Set(selection);
      if (next.has(file.id)) next.delete(file.id);
      else next.add(file.id);
      setSelection(next);
      setCursor(file.id);
      anchor.current = file.id;
    } else if (event.shiftKey && anchor.current) {
      event.preventDefault();
      selectRange(file.id);
    } else if (!selection.has(file.id)) {
      selectOnly(file.id);
    }
  };

  const menu = (event: React.MouseEvent, file: MediaFile) => {
    const ids = selection.has(file.id) ? selection : new Set([file.id]);
    if (!selection.has(file.id)) selectOnly(file.id);
    const targets = selectedSongs(ids);
    const single = targets.length === 1;
    const folder = containingFolder(file);
    const others = playlists?.playlists.filter((playlist) => playlist.id !== playlistId) ?? [];
    void showContextMenu(event, [
      { label: "播放", action: () => play(file) },
      { label: "下一首播放", action: () => player.playNext(targets) },
      { label: "添加到待播清单", action: () => player.addToQueue(targets) },
      ...(playlists
        ? [
            "separator" as const,
            {
              label: "添加到播放列表",
              submenu: [
                { label: "新建播放列表", action: () => playlists.create(targets) },
                ...(others.length ? ["separator" as const] : []),
                ...others.map((playlist) => ({ label: playlist.name, action: () => playlists.add(playlist, targets) })),
              ],
            },
          ]
        : []),
      "separator",
      {
        label: "在文件中显示",
        enabled: single && !!folder,
        action: () => folder && onNavigate({ name: "storage", accountId: file.accountId, path: folder }),
      },
      ...(onRemove
        ? ["separator" as const, { label: single ? "从播放列表中移除" : `从播放列表中移除 ${targets.length} 首歌曲`, action: () => onRemove(targets) }]
        : []),
    ]);
  };

  const onDragStart = (event: React.DragEvent, file: MediaFile) => {
    const ids = selection.has(file.id) ? selectedSongs().map((item) => item.id) : [file.id];
    if (!selection.has(file.id)) selectOnly(file.id);
    draggingSongs = { ids, from: resetKey };
    event.dataTransfer.effectAllowed = onReorder ? "copyMove" : "copy";
    event.dataTransfer.setData(SONGS_DRAG_TYPE, JSON.stringify(ids));
    event.dataTransfer.setDragImage(dragBadge(ids.length, event.clientX, event.clientY), -8, -8);
  };

  const onRowDragOver = (event: React.DragEvent, file: MediaFile) => {
    if (!onReorder || draggingSongs?.from !== resetKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    setDrop((current) => (current?.id === file.id && current.after === after ? current : { id: file.id, after }));
  };

  const onRowDrop = (event: React.DragEvent, file: MediaFile) => {
    if (!onReorder || !draggingSongs || draggingSongs.from !== resetKey || !drop) return;
    event.preventDefault();
    const position = songs.findIndex((item) => item.id === file.id);
    const beforeId = drop.after ? (songs[position + 1]?.id ?? null) : file.id;
    onReorder(draggingSongs.ids, beforeId);
    setDrop(null);
  };

  return (
    <div
      ref={table}
      className="table songs"
      role="grid"
      aria-label="歌曲"
      aria-multiselectable="true"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
      }}
      style={{ "--columns": "40px minmax(160px, 2.2fr) minmax(100px, 1.2fr) minmax(100px, 1.2fr) 64px 72px" } as CSSProperties}
    >
      <div className="table-header" role="row">
        <span className="th end">#</span>
        {header("title", "标题")}
        {header("artist", "艺人", "col-artist")}
        {header("folder", "文件夹", "col-folder")}
        <span className="th col-kind">种类</span>
        {header("size", "大小", "end")}
      </div>
      <div className="table-body">
        {visible.map((file, index) => {
          const parts = songParts(file);
          const current = file.id === currentId;
          const dropClass = drop?.id === file.id ? (drop.after ? "drop-after" : "drop-before") : "";
          return (
            <div
              key={file.id}
              data-id={file.id}
              role="row"
              aria-selected={selection.has(file.id)}
              className={`table-row ${current ? "current" : ""} ${dropClass}`}
              draggable
              onMouseDown={(event) => onRowMouseDown(event, file)}
              onClick={(event) => {
                if (!event.metaKey && !event.shiftKey && selection.size > 1) selectOnly(file.id);
              }}
              onDoubleClick={() => play(file)}
              onContextMenu={(event) => menu(event, file)}
              onDragStart={(event) => onDragStart(event, file)}
              onDragEnd={() => {
                draggingSongs = null;
                setDrop(null);
              }}
              onDragOver={(event) => onRowDragOver(event, file)}
              onDrop={(event) => onRowDrop(event, file)}
            >
              <span className="cell end index-cell">
                {player.openingId === file.id ? (
                  <LoaderCircle className="spin" size={13} />
                ) : current ? (
                  <AudioLines size={14} className={playing ? "pulse" : ""} />
                ) : (
                  <span className="tabular secondary index-number">{index + 1}</span>
                )}
                {!current && player.openingId !== file.id && (
                  <button className="row-play" aria-label={`播放 ${parts.title}`} tabIndex={-1} onClick={() => play(file)}>
                    <Play size={11} fill="currentColor" strokeWidth={0} />
                  </button>
                )}
              </span>
              <span className="cell" title={parts.title}>
                <span className="text">{parts.title}</span>
              </span>
              <span className="cell secondary col-artist">
                <span className="text">{parts.artist || "未知艺人"}</span>
              </span>
              <span className="cell secondary col-folder" title={musicFolderOf(file)}>
                <span className="text">{musicFolderOf(file)}</span>
              </span>
              <span className="cell secondary col-kind">
                <span className="badge">{extensionOf(file.displayName).toUpperCase() || "音频"}</span>
              </span>
              <span className="cell end secondary tabular">{formatBytes(file.size)}</span>
            </div>
          );
        })}
        {!limit && <div ref={sentinel} className="sentinel" />}
      </div>
    </div>
  );
}
