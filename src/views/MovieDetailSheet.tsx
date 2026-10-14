import { useEffect, useRef, useState } from "react";
import { CircleAlert, Ellipsis, Film, LoaderCircle, Play, Star, X } from "lucide-react";
import { containingFolder, displayTitleOf, episodeNumberOf, episodeOf, qualityOf, seasonLabel, seasonOf, uniqueEpisodes, type MediaWork } from "../lib/media";
import type { Route } from "../app/navigation";
import { showContextMenu } from "../lib/native";
import { formatBytes } from "../lib/format";
import { getMovieMetadata, type MediaFile, type MovieMetadata } from "../lib/nimbus";
import { usePlayer } from "../player/PlayerProvider";
import { Segmented } from "../ui/controls";
import { Sheet } from "../ui/Sheet";
import type { Notify } from "../ui/Toasts";
import { workSubtitle } from "./MoviesView";

type Props = {
  work: MediaWork;
  metadata?: MovieMetadata;
  onClose: () => void;
  onMetadata: (workId: string, metadata: MovieMetadata) => void;
  onNavigate: (route: Route) => void;
  notify: Notify;
};

/** Title page in the style of the TV app: artwork, facts, seasons and versions. */
export function MovieDetailSheet({ work, metadata: initial, onClose, onMetadata, onNavigate, notify }: Props) {
  const player = usePlayer();
  const [metadata, setMetadata] = useState<MovieMetadata | undefined>(initial);
  const [error, setError] = useState<string | null>(null);
  const [matchOpen, setMatchOpen] = useState(false);
  const [matchQuery, setMatchQuery] = useState(work.title);
  const [matching, setMatching] = useState(false);
  const [season, setSeason] = useState(work.seasons[0] ?? 1);
  const request = useRef(0);

  useEffect(() => {
    const generation = ++request.current;
    getMovieMetadata(work)
      .then((value) => {
        if (generation !== request.current) return;
        setMetadata(value);
        onMetadata(work.id, value);
      })
      .catch((cause) => {
        if (generation === request.current && !initial) setError(cause instanceof Error ? cause.message : String(cause));
      });
    // Load once per work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work.id]);

  const rematch = async (event: React.FormEvent) => {
    event.preventDefault();
    const query = matchQuery.trim();
    if (!query) return;
    const generation = ++request.current;
    setMatching(true);
    setError(null);
    try {
      const value = await getMovieMetadata(work, { match: query });
      if (generation !== request.current) return;
      setMetadata(value);
      onMetadata(work.id, value);
      setMatchOpen(false);
      notify("已更新作品资料", "success");
    } catch (cause) {
      if (generation === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === request.current) setMatching(false);
    }
  };

  const play = (file: MediaFile, fromStart = false) => {
    onClose();
    void player.play(file, { fromStart });
  };

  const episodes = work.isSeries ? uniqueEpisodes(work.files).filter((file) => seasonOf(file) === season) : [];
  const versionsOf = (episode: MediaFile) =>
    work.files.filter((file) => seasonOf(file) === seasonOf(episode) && episodeOf(file) === episodeOf(episode));
  const primary = work.isSeries ? episodes[0] ?? work.files[0] : work.files[0];
  const title = displayTitleOf(work, metadata);
  const folder = containingFolder(work.files[0]);

  return (
    <Sheet onClose={onClose} label={`${title} 简介`} width={780} centered className="sheet detail-sheet">
      <button className="icon-btn detail-close" aria-label="关闭" title="关闭" onClick={onClose}>
        <X size={15} />
      </button>
      <div className="detail-hero">
        <div className="detail-poster">
          {metadata?.posterUrl ? <img src={metadata.posterUrl} alt="" draggable={false} /> : <Film size={40} strokeWidth={1.3} />}
        </div>
        <div className="detail-info">
          <p className="detail-kind">{work.isSeries || metadata?.mediaType === "tv" ? "剧集" : "电影"}</p>
          <h2 className="detail-title selectable">{title}</h2>
          {metadata?.originalTitle && metadata.originalTitle !== title && (
            <p className="detail-original selectable">{metadata.originalTitle}</p>
          )}
          <p className="detail-facts">
            {metadata && metadata.rating > 0 && (
              <span className="detail-rating">
                <Star size={11} fill="currentColor" strokeWidth={0} />
                {metadata.rating.toFixed(1)}
              </span>
            )}
            <span>{workSubtitle(work, metadata)}</span>
            {metadata?.genres.length ? <span>{metadata.genres.slice(0, 3).join(" · ")}</span> : null}
          </p>
          <div className="detail-actions">
            <button className="btn prominent large" data-autofocus disabled={!primary} onClick={() => primary && play(primary)}>
              {primary && player.openingId === primary.id ? <LoaderCircle className="spin" size={14} /> : <Play size={13} fill="currentColor" strokeWidth={0} />}
              {work.isSeries ? (work.seasons.length > 1 ? (season === 0 ? "播放特别篇" : `播放第 ${season} 季`) : "播放第一集") : "播放"}
            </button>
            <button
              className="btn large more-btn"
              title="更多"
              aria-label="更多操作"
              onClick={(event) =>
                void showContextMenu(event, [
                  { label: "修正匹配…", action: () => setMatchOpen(true) },
                  {
                    label: "在文件中显示",
                    enabled: !!folder,
                    action: () => {
                      if (!folder) return;
                      onClose();
                      onNavigate({ name: "storage", accountId: work.files[0].accountId, path: folder });
                    },
                  },
                ])
              }
            >
              <Ellipsis size={15} />
            </button>
          </div>
          {matchOpen && (
            <form className="match-form" onSubmit={rematch}>
              <input
                className="field"
                value={matchQuery}
                autoFocus
                placeholder="片名，可附带年份"
                aria-label="用于匹配的片名"
                onChange={(event) => setMatchQuery(event.target.value)}
              />
              <button className="btn" type="submit" disabled={matching || !matchQuery.trim()}>
                {matching && <LoaderCircle className="spin" size={12} />}
                {matching ? "正在匹配…" : "匹配"}
              </button>
            </form>
          )}
          {error && (
            <p className="form-error">
              <CircleAlert size={14} />
              无法载入资料：{error}
            </p>
          )}
          {metadata?.overview && <p className="detail-overview selectable">{metadata.overview}</p>}
          {metadata?.cast.length ? (
            <p className="detail-cast selectable">
              <span>主演</span>
              {metadata.cast.slice(0, 6).join("、")}
            </p>
          ) : null}
        </div>
      </div>

      {(work.isSeries || work.files.length > 1) && (
        <div className="detail-files">
          {work.isSeries ? (
            <>
              <div className="detail-files-header">
                <h3>剧集</h3>
                {work.seasons.length > 1 && (
                  <Segmented<string>
                    ariaLabel="季"
                    value={String(season)}
                    onChange={(value) => setSeason(Number(value))}
                    options={work.seasons.map((value) => ({ value: String(value), label: seasonLabel(value) }))}
                  />
                )}
              </div>
              <ol className="episode-list">
                {episodes.map((episode, index) => {
                  const versions = versionsOf(episode);
                  return (
                    <li key={episode.id} className="episode-row">
                      <button className="episode-main" onClick={() => play(versions[0])} title={episode.displayName}>
                        <span className="episode-number tabular">{episodeNumberOf(episode) ?? index + 1}</span>
                        <span className="episode-name truncate">{episode.displayName.replace(/\.[^.]+$/, "")}</span>
                      </button>
                      <span className="episode-versions">
                        {versions.map((file) => (
                          <button key={file.id} className="badge-btn" title={`播放 ${file.displayName}`} onClick={() => play(file)}>
                            {qualityOf(file)}
                          </button>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <>
              <div className="detail-files-header">
                <h3>版本</h3>
              </div>
              <ol className="episode-list">
                {work.files.map((file) => (
                  <li key={file.id} className="episode-row">
                    <button className="episode-main" onClick={() => play(file)} title={file.displayName}>
                      <span className="badge">{qualityOf(file)}</span>
                      <span className="episode-name truncate">{file.displayName}</span>
                      <span className="secondary tabular">{formatBytes(file.size, "")}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
