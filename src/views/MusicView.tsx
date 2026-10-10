import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AudioLines, LoaderCircle, Music2, Play, Shuffle } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { formatBytes, plural } from "../lib/format";
import { containingFolder, matchesMusicQuery, musicFolderOf, musicSourceOf, songParts } from "../lib/media";
import { showContextMenu } from "../lib/native";
import type { MediaFile } from "../lib/nimbus";
import { extensionOf } from "../lib/storage";
import { usePlayer } from "../player/PlayerProvider";
import { usePlayerStatus } from "../player/statusStore";
import { EmptyState, Popup, SearchField, useIncrementalCount } from "../ui/controls";

type MusicSort = "title" | "artist" | "folder" | "source" | "size";

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

type Props = { library: Library; sourceId?: string; onNavigate: (route: Route) => void };

export function MusicView({ library, sourceId, onNavigate }: Props) {
  const player = usePlayer();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<MusicSort>(() => {
    try {
      const saved = localStorage.getItem("cove-music-sort") as MusicSort | null;
      return saved && ["title", "artist", "folder", "source", "size"].includes(saved) ? saved : "title";
    } catch {
      return "title";
    }
  });
  const source = library.sources.find((item) => item.id === sourceId);

  const songs = useMemo(() => {
    const scoped = sourceId
      ? library.songs.filter((file) => file.sourceIds?.includes(sourceId) || file.sourceId === sourceId)
      : library.songs;
    const key = (file: MediaFile) => {
      if (sort === "artist") return songParts(file).artist || "￿";
      if (sort === "folder") return musicFolderOf(file);
      if (sort === "source") return musicSourceOf(file, library.sources, library.accounts);
      return songParts(file).title;
    };
    return scoped
      .filter((file) => matchesMusicQuery(file, filter))
      .sort((left, right) =>
        sort === "size"
          ? right.size - left.size
          : collator.compare(key(left), key(right)) || collator.compare(songParts(left).title, songParts(right).title),
      );
  }, [filter, library.accounts, library.songs, library.sources, sort, sourceId]);

  return (
    <div className="page">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">{source?.label ?? "音乐"}</h1>
          <p className="page-subtitle">
            {filter.trim() ? `找到 ${plural(songs.length, "首歌曲")}` : plural(songs.length, "首歌曲")}
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
      <div className="filter-bar">
        <SearchField small value={filter} onChange={setFilter} placeholder="过滤歌曲、艺人或文件夹" style={{ width: 240 }} />
        <Popup<MusicSort>
          ariaLabel="排序方式"
          value={sort}
          onChange={(value) => {
            setSort(value);
            try {
              localStorage.setItem("cove-music-sort", value);
            } catch {
              // Preferences are best effort.
            }
          }}
          options={[
            { value: "title", label: "按标题" },
            { value: "artist", label: "按艺人" },
            { value: "folder", label: "按文件夹" },
            { value: "source", label: "按来源" },
            { value: "size", label: "按大小" },
          ]}
        />
      </div>
      {songs.length ? (
        <SongTable songs={songs} library={library} onNavigate={onNavigate} resetKey={`${filter}|${sort}|${sourceId}`} />
      ) : (
        <EmptyState
          icon={<Music2 size={44} strokeWidth={1.3} />}
          title={filter.trim() ? "没有匹配的歌曲" : "音乐资料库是空的"}
          message={filter.trim() ? "试试歌曲名、艺人或文件夹名。" : "在“文件”中打开一个文件夹，把它设为音乐文件夹。"}
        >
          {filter.trim() ? (
            <button className="btn" onClick={() => setFilter("")}>
              清除过滤
            </button>
          ) : (
            <button className="btn" onClick={() => onNavigate({ name: "files" })}>
              前往文件
            </button>
          )}
        </EmptyState>
      )}
    </div>
  );
}

/** Songs list with Music.app semantics: click selects, double-click or Return plays. */
export function SongTable({
  songs,
  library,
  onNavigate,
  resetKey,
  limit,
}: {
  songs: MediaFile[];
  library: Library;
  onNavigate: (route: Route) => void;
  resetKey: string;
  limit?: number;
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
        <span className="th">标题</span>
        <span className="th col-artist">艺人</span>
        <span className="th col-folder">文件夹</span>
        <span className="th col-kind">种类</span>
        <span className="th end">大小</span>
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
