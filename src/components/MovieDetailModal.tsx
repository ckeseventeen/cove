import { useEffect, useRef, useState } from "react";
import { Film, Play, X } from "lucide-react";
import { episodeOf, qualityOf, seasonOf, uniqueEpisodes, type MediaWork } from "../lib/media";
import { getMovieMetadata, type MediaFile, type MovieMetadata } from "../lib/nimbus";

type Props = {
  work: MediaWork | null;
  initialMetadata: MovieMetadata | null;
  onClose: () => void;
  onPlayFile: (file: MediaFile) => void;
  onNotice: (notice: string) => void;
  onMetadataUpdate: (workId: string, metadata: MovieMetadata) => void;
};

export function MovieDetailModal({
  work,
  initialMetadata,
  onClose,
  onPlayFile,
  onNotice,
  onMetadataUpdate,
}: Props) {
  const [workMetadata, setWorkMetadata] = useState<MovieMetadata | null>(initialMetadata);
  const [matchQuery, setMatchQuery] = useState("");
  const [matching, setMatching] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState(1);
  const matchGeneration = useRef(0);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!work) {
      setWorkMetadata(null);
      setError(null);
      return;
    }
    setWorkMetadata(initialMetadata);
    setMatchQuery(work.title);
    setSelectedSeason(work.seasons[0] ?? 1);
    setError(null);
    const generation = ++matchGeneration.current;
    getMovieMetadata(work.files[0].id, false, work.title)
      .then((metadata) => {
        if (generation === matchGeneration.current) {
          setWorkMetadata(metadata);
          onMetadataUpdate(work.id, metadata);
        }
      })
      .catch((cause) => {
        if (generation === matchGeneration.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
  }, [work, initialMetadata]);

  if (!work) return null;

  async function handleRematch(event: React.FormEvent) {
    event.preventDefault();
    if (!work || !matchQuery.trim()) return;
    const generation = ++matchGeneration.current;
    setMatching(true);
    setError(null);
    try {
      const metadata = await getMovieMetadata(work.files[0].id, true, matchQuery.trim());
      if (generation === matchGeneration.current) {
        setWorkMetadata(metadata);
        onMetadataUpdate(work.id, metadata);
        onNotice("作品匹配已更新并保存");
      }
    } catch (cause) {
      if (generation === matchGeneration.current) {
        onNotice(`匹配失败：${cause instanceof Error ? cause.message : String(cause)}`);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (generation === matchGeneration.current) {
        setMatching(false);
      }
    }
  }

  const isSeries = work.isSeries;
  const currentEpisodes = isSeries
    ? uniqueEpisodes(work.files).filter((file) => seasonOf(file) === selectedSeason)
    : [work.files[0]];

  return (
    <div className="movie-detail-backdrop" onClick={onClose}>
      <section
        className="movie-detail"
        role="dialog"
        aria-modal="true"
        aria-label={`${work.title} 详情`}
        onClick={(event) => event.stopPropagation()}
      >
        <button className="movie-detail-close" aria-label="关闭详情" onClick={onClose}>
          <X size={20} />
        </button>
        <div className={`movie-detail-poster ${workMetadata?.posterUrl ? "has-poster" : ""}`}>
          {workMetadata?.posterUrl ? (
            <img src={workMetadata.posterUrl} alt={`${workMetadata.title} 海报`} />
          ) : (
            <Film size={54} />
          )}
        </div>
        <div className="movie-detail-copy">
          <p className="eyebrow">{isSeries ? "剧集" : "电影"}</p>
          <h2>{workMetadata?.title || work.title}</h2>
          <p className="movie-meta">
            {workMetadata?.year ?? "年份未知"}
            {workMetadata ? ` · ${workMetadata.rating.toFixed(1)} 分` : ""} ·{" "}
            {isSeries
              ? `${work.seasons.length} 季 / ${uniqueEpisodes(work.files).length} 集`
              : work.files.length > 1
              ? `${work.files.length} 个版本`
              : qualityOf(work.files[0])}
          </p>
          <div style={{ margin: "14px 0 16px 0", display: "flex", gap: "12px", alignItems: "center" }}>
            <button
              className="button primary"
              style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "10px 22px", fontSize: "15px", fontWeight: 600 }}
              onClick={() => {
                onClose();
                onPlayFile(currentEpisodes[0] || work.files[0]);
              }}
            >
              <Play size={18} fill="currentColor" />
              {isSeries ? (work.seasons.length > 1 ? `播放第 ${selectedSeason} 季第 1 集` : "播放第 1 集") : "立即播放"}
            </button>
          </div>
          <form className="match-form" onSubmit={handleRematch}>
            <label>
              修正匹配
              <input
                value={matchQuery}
                onChange={(event) => setMatchQuery(event.target.value)}
                placeholder="片名，可附带年份"
              />
            </label>
            <button className="button secondary" disabled={matching || !matchQuery.trim()}>
              {matching ? "匹配中…" : "重新匹配"}
            </button>
          </form>
          {error && <p className="movie-error" style={{ color: "#ef4444", marginTop: 12 }}>加载元数据失败：{error}</p>}
          {workMetadata?.overview && <p className="movie-overview">{workMetadata.overview}</p>}
          {workMetadata?.cast && workMetadata.cast.length > 0 && (
            <p className="movie-cast">
              <strong>主演</strong>
              {workMetadata.cast.slice(0, 7).join(" · ")}
            </p>
          )}
        </div>
        <div className="season-browser">
          {isSeries && (
            <div className="season-tabs">
              {work.seasons.map((season) => (
                <button
                  className={selectedSeason === season ? "active" : ""}
                  key={season}
                  onClick={() => setSelectedSeason(season)}
                >
                  第 {season} 季
                </button>
              ))}
            </div>
          )}
          <div className={isSeries ? "episode-grid" : "edition-list"}>
            {currentEpisodes.map((episode, index) => (
              <div className="episode-editions" key={episode.id}>
                <strong>{isSeries ? `第 ${episodeOf(episode) ?? index + 1} 集` : "选择播放版本"}</strong>
                {(isSeries
                  ? work.files.filter(
                      (file) =>
                        seasonOf(file) === seasonOf(episode) &&
                        episodeOf(file) === episodeOf(episode)
                    )
                  : work.files
                ).map((file) => (
                  <button
                    className="episode-button"
                    key={file.id}
                    onClick={() => {
                      onClose();
                      onPlayFile(file);
                    }}
                  >
                    <span className="episode-play">
                      <Play size={14} fill="currentColor" />
                    </span>
                    <span>
                      <strong>{qualityOf(file)}</strong>
                      <small>{file.displayName}</small>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
