import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AudioLines, ChevronDown, ChevronUp, LoaderCircle, Music2, Play, Shuffle } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { formatBytes, plural } from "../lib/format";
import { containingFolder, musicFolderOf, songParts } from "../lib/media";
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
          : collator.compare(key(left), key(right)) || collator.compare(songParts(left).title, songParts(right).title)),
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

/** Songs list with Music.app semantics: click selects, double-click or Return plays. */
export function SongTable({
  songs,
  onNavigate,
  resetKey,
  limit,
  sort,
  onSort,
}: {
  songs: MediaFile[];
  onNavigate: (route: Route) => void;
  resetKey: string;
  limit?: number;
  sort?: SongSort;
  onSort?: (field: SongSortField) => void;
}) {
  const player = usePlayer();
  const [selected, setSelected] = useState<string | null>(null);
  const table = useRef<HTMLDivElement>(null);
  const { count, sentinel } = useIncrementalCount(limit ?? songs.length, 150, resetKey);
  const visible = songs.slice(0, limit ? Math.min(limit, count) : count);
  const currentId = !player.isVideo ? player.nowPlaying?.id : undefined;
  const playing = usePlayerStatus((status) => !!currentId && status.fileId === currentId && !status.paused);

  useEffect(() => {
    table.current?.querySelector(`[data-id="${CSS.escape(selected ?? "")}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const play = (file: MediaFile) => void player.play(file, { queue: songs, fromStart: true });

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
    const index = visible.findIndex((file) => file.id === selected);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) setSelected(next.id);
    } else if (event.key === "Enter" && index >= 0) {
      event.preventDefault();
      play(visible[index]);
    }
  };

  const menu = (event: React.MouseEvent, file: MediaFile) => {
    setSelected(file.id);
    const folder = containingFolder(file);
    void showContextMenu(event, [
      { label: "播放", action: () => play(file) },
      { label: "下一首播放", action: () => player.playNext(file) },
      { label: "添加到待播清单", action: () => player.addToQueue(file) },
      "separator",
      {
        label: "在文件中显示",
        enabled: !!folder,
        action: () => folder && onNavigate({ name: "storage", accountId: file.accountId, path: folder }),
      },
    ]);
  };

  return (
    <div
      ref={table}
      className="table songs"
      role="grid"
      aria-label="歌曲"
      tabIndex={0}
      onKeyDown={onKeyDown}
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
          return (
            <div
              key={file.id}
              data-id={file.id}
              role="row"
              aria-selected={selected === file.id}
              className={`table-row ${current ? "current" : ""}`}
              onMouseDown={() => setSelected(file.id)}
              onDoubleClick={() => play(file)}
              onContextMenu={(event) => menu(event, file)}
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
