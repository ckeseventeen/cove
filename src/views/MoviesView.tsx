import { useEffect, useMemo, useRef, useState } from "react";
import { Film, LoaderCircle, Play } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { plural } from "../lib/format";
import { categoryOf, containingFolder, displayTitleOf, lookupNameOf, uniqueEpisodes, versionCountOf, type MediaWork } from "../lib/media";
import { showContextMenu } from "../lib/native";
import { getMovieMetadata, type MovieMetadata } from "../lib/nimbus";
import { usePlayer } from "../player/PlayerProvider";
import { EmptyState, Popup, Segmented, useIncrementalCount } from "../ui/controls";

export type MovieCategory = "all" | "movie" | "tv" | "documentary" | "animation";
type MovieSort = "title" | "recent" | "oldest" | "rating";

function useStoredState<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key) as T | null;
      return saved && allowed.includes(saved) ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  const update = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // Preferences are best effort.
    }
  };
  return [value, update] as const;
}

type Props = {
  library: Library;
  sourceId?: string;
  onOpenWork: (work: MediaWork) => void;
  onNavigate: (route: Route) => void;
};

export function MoviesView({ library, sourceId, onOpenWork, onNavigate }: Props) {
  const [category, setCategory] = useStoredState<MovieCategory>("cove-movie-category", ["all", "movie", "tv", "documentary", "animation"], "all");
  const [sort, setSort] = useStoredState<MovieSort>("cove-movie-sort", ["title", "recent", "oldest", "rating"], "title");
  const source = library.sources.find((item) => item.id === sourceId);
  const { movieMetadata } = library;

  const scoped = useMemo(
    () =>
      sourceId
        ? library.works.filter((work) => work.files.some((file) => file.sourceIds?.includes(sourceId) || file.sourceId === sourceId))
        : library.works,
    [library.works, sourceId],
  );

  const shown = useMemo(
    () =>
      scoped
        .filter((work) => category === "all" || categoryOf(work, movieMetadata[work.id]) === category)
        .sort((a, b) => {
          const left = movieMetadata[a.id];
          const right = movieMetadata[b.id];
          if (sort === "oldest") return (left?.year ?? 9999) - (right?.year ?? 9999);
          if (sort === "recent") return (right?.year ?? 0) - (left?.year ?? 0);
          if (sort === "rating") return (right?.rating ?? -1) - (left?.rating ?? -1);
          return (left?.title ?? a.title).localeCompare(right?.title ?? b.title, "zh-CN", { numeric: true });
        }),
    [category, movieMetadata, scoped, sort],
  );

  const { count, sentinel } = useIncrementalCount(shown.length, 60, `${category}|${sort}|${sourceId}`);
  const filtered = category !== "all";

  return (
    <div className="page">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">{source?.label ?? "影视"}</h1>
          <p className="page-subtitle">
            {plural(shown.length, "部作品")}
            {source && (
              <>
                {" · "}
                <button className="btn plain inline" onClick={() => onNavigate({ name: "movies" })}>
                  显示全部影视
                </button>
              </>
            )}
          </p>
        </div>
      </header>
      <div className="filter-bar">
        <Segmented<MovieCategory>
          ariaLabel="类别"
          value={category}
          onChange={setCategory}
          options={[
            { value: "all", label: "全部" },
            { value: "movie", label: "电影" },
            { value: "tv", label: "剧集" },
            { value: "documentary", label: "纪录片" },
            { value: "animation", label: "动画" },
          ]}
        />
        <div className="group">
          <Popup<MovieSort>
            ariaLabel="排序方式"
            value={sort}
            onChange={setSort}
            options={[
              { value: "title", label: "按片名" },
              { value: "recent", label: "按年份（新→旧）" },
              { value: "oldest", label: "按年份（旧→新）" },
              { value: "rating", label: "按评分" },
            ]}
          />
        </div>
      </div>

      {shown.length ? (
        <div className="poster-grid">
          {shown.slice(0, count).map((work) => (
            <MovieCard
              key={work.id}
              work={work}
              metadata={movieMetadata[work.id]}
              onMetadata={(metadata) => library.setMovieMetadata(work.id, metadata)}
              onOpen={() => onOpenWork(work)}
              onNavigate={onNavigate}
            />
          ))}
          <div ref={sentinel} className="sentinel" />
        </div>
      ) : (
        <EmptyState
          icon={<Film size={44} strokeWidth={1.3} />}
          title={filtered ? "没有符合条件的作品" : "影视资料库是空的"}
          message={
            filtered
              ? "这个类别下暂时没有作品。"
              : "在左侧“位置”中打开存放影片的文件夹，选择“添加到资料库”，Cove 会整理其中的电影和剧集。"
          }
        >
          {filtered ? (
            <button className="btn" onClick={() => setCategory("all")}>
              显示全部
            </button>
          ) : (
            <button className="btn" onClick={() => onNavigate({ name: "storage", accountId: "local", path: "/" })}>
              打开本地磁盘
            </button>
          )}
        </EmptyState>
      )}
    </div>
  );
}

export function workSubtitle(work: MediaWork, metadata?: MovieMetadata) {
  const parts: string[] = [];
  if (metadata?.year) parts.push(String(metadata.year));
  if (work.isSeries) {
    const seasons = work.seasons.filter((season) => season > 0).length;
    if (seasons > 1) parts.push(`${seasons} 季`);
    parts.push(`${uniqueEpisodes(work.files).length} 集`);
  } else if (versionCountOf(work) > 1) parts.push(`${versionCountOf(work)} 个版本`);
  return parts.join(" · ") || "影片";
}

function MovieCard({
  work,
  metadata,
  onMetadata,
  onOpen,
  onNavigate,
}: {
  work: MediaWork;
  metadata?: MovieMetadata;
  onMetadata: (metadata: MovieMetadata) => void;
  onOpen: () => void;
  onNavigate: (route: Route) => void;
}) {
  const player = usePlayer();
  const card = useRef<HTMLDivElement>(null);
  const requested = useRef(!!metadata);
  const first = work.files[0];
  const opening = work.files.some((file) => file.id === player.openingId);

  useEffect(() => {
    const element = card.current;
    if (!element || requested.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        requested.current = true;
        getMovieMetadata(first.id, false, lookupNameOf(work), work.isSeries).then(onMetadata).catch(() => undefined);
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
    // Metadata is fetched once per work as it scrolls into view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.id, work.title]);

  const title = displayTitleOf(work, metadata);
  const play = () => void player.play(first);
  const folder = containingFolder(first);
  return (
    <div
      ref={card}
      className="poster"
      role="button"
      tabIndex={0}
      aria-label={`${title}，${workSubtitle(work, metadata)}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={(event) =>
        void showContextMenu(event, [
          { label: work.isSeries ? "播放第一集" : "播放", action: play },
          { label: "显示简介", action: onOpen },
          "separator",
          {
            label: "在文件中显示",
            enabled: !!folder,
            action: () => folder && onNavigate({ name: "storage", accountId: first.accountId, path: folder }),
          },
        ])
      }
    >
      <div className={`poster-art ${metadata?.posterUrl ? "has-image" : ""}`}>
        {metadata?.posterUrl ? (
          <img src={metadata.posterUrl} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="poster-fallback">
            <Film size={22} strokeWidth={1.4} />
            <span>{work.title}</span>
          </span>
        )}
        <button
          className={`poster-play ${opening ? "busy" : ""}`}
          aria-label={`播放 ${title}`}
          title="播放"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            play();
          }}
        >
          {opening ? <LoaderCircle className="spin" size={15} /> : <Play size={15} fill="currentColor" strokeWidth={0} />}
        </button>
      </div>
      <div className="poster-title truncate" title={title}>
        {title}
      </div>
      <div className="poster-subtitle truncate">{workSubtitle(work, metadata)}</div>
    </div>
  );
}
