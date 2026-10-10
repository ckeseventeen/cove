import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { songParts } from "../lib/media";
import { useTopmostEscape } from "../ui/Sheet";
import { Lyrics } from "./Lyrics";
import { Artwork, ProgressBar, TransportButtons, VolumeControl } from "./MiniPlayer";
import { usePlayer } from "./PlayerProvider";

/** Full-window player with large artwork and lyrics, as in Music's full screen player. */
export function NowPlaying() {
  const player = usePlayer();
  const open = player.fullScreen && !!player.nowPlaying && !player.isVideo;
  useTopmostEscape(open, () => player.setFullScreen(false));
  if (!open || !player.nowPlaying) return null;
  const parts = songParts(player.nowPlaying);
  const art = player.metadata?.artworkUrl;
  return createPortal(
    <section className="now-playing" role="dialog" aria-modal="true" aria-label="正在播放">
      <div className="np-backdrop" aria-hidden="true">
        {art && <img src={art} alt="" />}
      </div>
      <header className="np-header" data-tauri-drag-region>
        <button className="np-close" aria-label="关闭正在播放" title="关闭" onClick={() => player.setFullScreen(false)}>
          <ChevronDown size={18} />
        </button>
      </header>
      <div className="np-main">
        <div className="np-left">
          <Artwork url={art} size={320} className="np-art" />
          <div className="np-meta">
            <h2 className="truncate">{player.metadata?.title || parts.title}</h2>
            <p className="truncate">
              {[player.metadata?.artist || parts.artist || "未知艺人", player.metadata?.album].filter(Boolean).join(" — ")}
            </p>
          </div>
          <ProgressBar className="np-progress" />
          <TransportButtons size={22} />
          <VolumeControl />
        </div>
        <div className="np-lyrics">
          <Lyrics variant="full" />
        </div>
      </div>
    </section>,
    document.body,
  );
}
