import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Play } from "lucide-react";
import { uniqueEpisodes, providerName, type MediaWork } from "../lib/media";
import { getMovieMetadata, type Account, type MovieMetadata } from "../lib/nimbus";

export function MovieCard({ work, index, opening, accounts, metadata, onMetadata, onOpen }: { work: MediaWork; index: number; opening: boolean; accounts: Account[]; metadata?: MovieMetadata; onMetadata: (metadata: MovieMetadata) => void; onOpen: (metadata: MovieMetadata | null) => void }) {
  const file = work.files[0];
  const card = useRef<HTMLElement>(null);
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    const element = card.current;
    if (!element || requested) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setRequested(true);
      getMovieMetadata(file.id, false, work.title).then((cached) => {
        onMetadata(cached);
        return cached;
      }).catch(() => undefined);
    }, { rootMargin: "280px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [file.id, requested]);
  return <article tabIndex={0} role="button" aria-label={`查看 ${metadata?.title || work.title}`} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(metadata ?? null); } }} ref={card} className={`media-card playable ${["violet", "amber", "blue"][index % 3]}`} onClick={() => onOpen(metadata ?? null)}>
    <div className={`poster-art ${metadata?.posterUrl ? "has-poster" : ""}`}>
      {metadata?.posterUrl && <img src={metadata.posterUrl} alt={`${metadata.title} 海报`} loading="lazy" />}
      {!metadata?.posterUrl && <span className="poster-placeholder-title">{work.title}</span>}
      <span className={`play-mark ${opening ? "loading" : ""}`} aria-hidden="true">
        {opening ? <LoaderCircle className="spin" size={22} /> : <Play size={20} fill="currentColor" />}
      </span>
    </div>
    <div className="card-copy"><h3 title={metadata?.title || work.title}>{metadata?.title || work.title}</h3><p>{metadata ? `${metadata.year ?? "年份未知"} · ${metadata.rating.toFixed(1)} 分` : providerName(file.accountId, accounts)}{work.isSeries ? ` · ${work.seasons.length > 1 ? `${work.seasons.length} 季 · ` : ""}共 ${uniqueEpisodes(work.files).length} 集` : work.files.length > 1 ? ` · ${work.files.length} 个版本` : ""}</p></div>
  </article>;
}

