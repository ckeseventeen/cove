import { MovieCard } from "../components/MovieCard";
import type { MediaWork } from "../lib/media";
import type { Account, MovieMetadata } from "../lib/nimbus";

export type MovieCategory = "all" | "movie" | "tv" | "documentary" | "animation";
export type MovieSort = "recent" | "oldest" | "rating" | "title";

type Props = {
  movieShelves: MediaWork[];
  accounts: Account[];
  movieMetadata: Record<string, MovieMetadata>;
  movieCategory: MovieCategory;
  onMovieCategoryChange: (category: MovieCategory) => void;
  movieYear: string;
  onMovieYearChange: (year: string) => void;
  movieYears: number[];
  movieSort: MovieSort;
  onMovieSortChange: (sort: MovieSort) => void;
  pageSize: number;
  onLoadMore: () => void;
  openingId: string | null;
  onMetadata: (metadata: MovieMetadata, workId: string) => void;
  onOpenWork: (work: MediaWork, metadata: MovieMetadata | null) => void;
  onResetFilters?: () => void;
};

const CATEGORIES: [MovieCategory, string][] = [
  ["all", "全部"],
  ["movie", "电影"],
  ["tv", "电视剧"],
  ["documentary", "纪录片"],
  ["animation", "动画"],
];

export function MovieView({
  movieShelves,
  accounts,
  movieMetadata,
  movieCategory,
  onMovieCategoryChange,
  movieYear,
  onMovieYearChange,
  movieYears,
  movieSort,
  onMovieSortChange,
  pageSize,
  onLoadMore,
  openingId,
  onMetadata,
  onOpenWork,
  onResetFilters,
}: Props) {
  return (
    <>
      <div className="movie-filterbar">
        <div className="category-tabs">
          {CATEGORIES.map(([value, label]) => (
            <button
              className={movieCategory === value ? "active" : ""}
              key={value}
              onClick={() => onMovieCategoryChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="movie-selectors">
          <select
            aria-label="按年份筛选"
            value={movieYear}
            onChange={(event) => onMovieYearChange(event.target.value)}
          >
            <option value="all">全部年份</option>
            {movieYears.map((year) => (
              <option value={year} key={year}>
                {year} 年
              </option>
            ))}
          </select>
          <select
            aria-label="影视排序"
            value={movieSort}
            onChange={(event) => onMovieSortChange(event.target.value as MovieSort)}
          >
            <option value="recent">年份：从新到旧</option>
            <option value="oldest">年份：从旧到新</option>
            <option value="rating">评分最高</option>
            <option value="title">片名排序</option>
          </select>
        </div>
      </div>
      <section className="media-grid cinema-grid">
        {movieShelves.slice(0, pageSize).map((work, index) => (
          <MovieCard
            key={work.id}
            work={work}
            index={index}
            opening={work.files.some((file) => openingId === file.id)}
            accounts={accounts}
            metadata={movieMetadata[work.id]}
            onMetadata={(metadata) => onMetadata(metadata, work.id)}
            onOpen={(metadata) => onOpenWork(work, metadata)}
          />
        ))}
        {movieShelves.length > pageSize && (
          <button className="button secondary load-more" onClick={onLoadMore}>
            显示更多作品（剩余 {movieShelves.length - pageSize} 部）
          </button>
        )}
        {movieShelves.length === 0 && (
          <div className="empty-library">
            <p>没有匹配的作品。可以清除筛选条件，或到“来源管理”添加影视目录。</p>
            {onResetFilters && (
              <button
                className="button secondary"
                style={{ marginTop: "12px" }}
                onClick={onResetFilters}
              >
                重置所有筛选
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
