import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, MicVocal } from "lucide-react";
import { parseSyncedLyrics } from "../lib/media";
import { showContextMenu } from "../lib/native";
import { EmptyState } from "../ui/controls";
import { usePlayer } from "./PlayerProvider";
import { usePlayerStatus } from "./statusStore";

function activeLine(lines: { time: number }[], position: number) {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].time <= position) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** Time-synced lyrics that follow playback until the reader scrolls away. */
export function Lyrics({ variant }: { variant: "panel" | "full" }) {
  const player = usePlayer();
  const fileId = player.nowPlaying?.id;
  const lines = useMemo(() => parseSyncedLyrics(player.metadata?.syncedLyrics), [player.metadata?.syncedLyrics]);
  const active = usePlayerStatus((status) => (status.fileId === fileId ? activeLine(lines, status.position + 0.2) : -1));
  const [follow, setFollow] = useState(true);
  const [fullText, setFullText] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFollow(true);
    setFullText(false);
    scroller.current?.scrollTo({ top: 0 });
  }, [fileId]);

  useEffect(() => {
    const panel = scroller.current;
    if (!panel || !follow || fullText) return;
    const line = panel.querySelector<HTMLElement>(`[data-line="${Math.max(0, active)}"]`);
    if (!line) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.scrollTo({
      top: line.offsetTop - panel.clientHeight * (variant === "full" ? 0.38 : 0.32) + line.offsetHeight / 2,
      behavior: reduce ? "auto" : "smooth",
    });
  }, [active, follow, fullText, variant, lines]);

  const plain = player.metadata?.lyrics?.trim();
  const stopFollowing = () => setFollow(false);

  if (!player.nowPlaying || player.isVideo) {
    return <EmptyState compact icon={<MicVocal size={36} strokeWidth={1.5} />} title="没有正在播放的歌曲" />;
  }
  if (!lines.length && !plain) {
    return (
      <EmptyState
        compact
        icon={player.metadataLoading ? <LoaderCircle className="spin" size={28} /> : <MicVocal size={36} strokeWidth={1.5} />}
        title={player.metadataLoading ? "正在查找歌词…" : "暂无歌词"}
        message={player.metadataLoading ? undefined : "没有为这首歌找到匹配的歌词。"}
      >
        {!player.metadataLoading && (
          <button className="btn" onClick={player.refreshMetadata}>
            重新匹配
          </button>
        )}
      </EmptyState>
    );
  }

  const showSynced = lines.length > 0 && !fullText;
  return (
    <div className={`lyrics lyrics-${variant}`}>
      <div
        ref={scroller}
        className={`lyrics-scroll ${showSynced ? "synced" : "plain"}`}
        tabIndex={0}
        aria-label="歌词"
        onContextMenu={(event) =>
          void showContextMenu(event, [
            ...(lines.length
              ? [{ label: fullText ? "显示同步歌词" : "显示全文", action: () => {
                  setFullText((value) => !value);
                  setFollow(true);
                } }]
              : []),
            { label: "重新匹配歌词", enabled: !player.metadataLoading, action: player.refreshMetadata },
          ])
        }
        onWheel={stopFollowing}
        onTouchStart={stopFollowing}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) stopFollowing();
        }}
      >
        {showSynced
          ? lines.map((line, index) => (
              <button
                key={`${line.time}-${index}`}
                data-line={index}
                className={`lyric-line ${index === active ? "active" : index < active ? "past" : ""}`}
                aria-current={index === active ? "true" : undefined}
                onClick={() => {
                  player.seek(line.time);
                  setFollow(true);
                }}
              >
                {line.text}
              </button>
            ))
          : (plain || lines.map((line) => line.text).join("\n")).split(/\r?\n/).map((line, index) => (
              <p key={index} className="lyric-text selectable">
                {line || " "}
              </p>
            ))}
      </div>
      {showSynced && !follow && (
        <div className="lyrics-footer">
          <button className="btn capsule tinted" onClick={() => setFollow(true)}>
            回到当前
          </button>
        </div>
      )}
    </div>
  );
}
