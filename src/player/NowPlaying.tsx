import { useEffect, useRef } from "react";
import { songParts } from "../lib/media";
import { useTopmostEscape } from "../ui/Sheet";
import { Lyrics } from "./Lyrics";
import { Artwork } from "./MiniPlayer";
import { QueueList } from "./PlayerPanel";
import { usePlayer } from "./PlayerProvider";

/**
 * Now Playing fills the content area under the toolbar, so the toolbar's transport, volume and
 * lyrics / up next buttons keep working and nothing is duplicated here. Clicking the artwork in the
 * toolbar, pressing Escape or choosing anything in the sidebar returns to the library.
 */
export function NowPlaying() {
  const player = usePlayer();
  const open = player.fullScreen && !!player.nowPlaying && !player.isVideo;
  // Escape closes it, but it is not modal: Space and the other window shortcuts keep working.
  useTopmostEscape(open, () => player.setFullScreen(false), false);
  const section = useRef<HTMLElement>(null);
  // Take the keyboard from the page underneath, so Space pauses instead of acting on a hidden list.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    section.current?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (previous?.isConnected && (!active || active === document.body)) previous.focus({ preventScroll: true });
    };
  }, [open]);
  if (!open || !player.nowPlaying) return null;
  const parts = songParts(player.nowPlaying);
  const art = player.metadata?.artworkUrl;
  return (
    <section ref={section} className="now-playing" data-side={player.panel ?? "none"} aria-label="正在播放" tabIndex={-1}>
      <div className="np-backdrop" aria-hidden="true">
        {art && <img src={art} alt="" />}
      </div>
      <div className="np-main">
        <div className="np-left">
          <Artwork url={art} size={320} className="np-art" />
          <div className="np-meta">
            <h2 className="truncate">{player.metadata?.title || parts.title}</h2>
            <p className="truncate">
              {[player.metadata?.artist || parts.artist || "未知艺人", player.metadata?.album].filter(Boolean).join(" — ")}
            </p>
          </div>
        </div>
        {player.panel === "lyrics" && (
          <div className="np-side np-lyrics">
            <Lyrics variant="full" />
          </div>
        )}
        {player.panel === "queue" && (
          <div className="np-side np-queue">
            <QueueList />
          </div>
        )}
      </div>
    </section>
  );
}
