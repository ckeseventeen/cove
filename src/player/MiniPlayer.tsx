import {
  AudioWaveform,
  ListMusic,
  LoaderCircle,
  MessageSquareQuote,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { songParts } from "../lib/media";
import { formatClock } from "../lib/format";
import { Slider } from "../ui/controls";
import { usePlayer } from "./PlayerProvider";
import { usePlayerStatus } from "./statusStore";

export function Artwork({ url, size, className = "" }: { url?: string; size: number; className?: string }) {
  return (
    <span className={`artwork ${className}`} style={{ width: size, height: size }}>
      {url ? <img src={url} alt="" draggable={false} /> : <Music2 size={Math.round(size * 0.42)} strokeWidth={1.6} />}
    </span>
  );
}

export function PlayPauseButton({ size = 18, className = "" }: { size?: number; className?: string }) {
  const player = usePlayer();
  const id = player.nowPlaying?.id;
  const showPlay = usePlayerStatus((status) => status.fileId !== id || status.paused || status.eofReached);
  const music = !!player.nowPlaying && !player.isVideo;
  return (
    <button
      className={`icon-btn transport-play ${className}`}
      disabled={!music || !!player.openingId}
      aria-label={showPlay ? "播放" : "暂停"}
      title={showPlay ? "播放" : "暂停"}
      onClick={player.togglePlay}
    >
      {player.openingId && music ? (
        <LoaderCircle className="spin" size={size} />
      ) : showPlay ? (
        <Play size={size} fill="currentColor" strokeWidth={0} />
      ) : (
        <Pause size={size} fill="currentColor" strokeWidth={0} />
      )}
    </button>
  );
}

export function ShuffleButton({ size = 15 }: { size?: number }) {
  const player = usePlayer();
  return (
    <button
      className="icon-btn"
      aria-pressed={player.shuffle}
      disabled={!player.nowPlaying || player.isVideo || player.queue.length < 2}
      title={player.shuffle ? "关闭随机播放" : "随机播放"}
      onClick={player.toggleShuffle}
    >
      <Shuffle size={size} />
    </button>
  );
}

export function RepeatButton({ size = 15 }: { size?: number }) {
  const player = usePlayer();
  const label = player.repeat === "off" ? "重复：关闭" : player.repeat === "all" ? "重复：全部" : "重复：单曲";
  return (
    <button
      className="icon-btn"
      aria-pressed={player.repeat !== "off"}
      disabled={!player.nowPlaying || player.isVideo}
      title={label}
      aria-label={label}
      onClick={player.cycleRepeat}
    >
      {player.repeat === "one" ? <Repeat1 size={size} /> : <Repeat size={size} />}
    </button>
  );
}

export function TransportButtons({ size = 16, extended = true }: { size?: number; extended?: boolean }) {
  const player = usePlayer();
  const music = !!player.nowPlaying && !player.isVideo;
  const canNext = music && player.currentIndex >= 0 && (player.currentIndex < player.queue.length - 1 || player.repeat === "all");
  return (
    <div className="transport">
      {extended && <ShuffleButton />}
      <button className="icon-btn" disabled={!music || !!player.openingId} title="上一首" aria-label="上一首" onClick={player.previous}>
        <SkipBack size={size} fill="currentColor" strokeWidth={0} />
      </button>
      <PlayPauseButton size={size + 4} />
      <button className="icon-btn" disabled={!canNext || !!player.openingId} title="下一首" aria-label="下一首" onClick={player.next}>
        <SkipForward size={size} fill="currentColor" strokeWidth={0} />
      </button>
      {extended && <RepeatButton />}
    </div>
  );
}

export function ProgressBar({ className = "" }: { className?: string }) {
  const player = usePlayer();
  const id = player.nowPlaying?.id;
  const position = usePlayerStatus((status) => (status.fileId === id ? Math.floor(status.position) : 0));
  const duration = usePlayerStatus((status) => (status.fileId === id ? Math.floor(status.duration) : 0));
  return (
    <div className={`progress-row ${className}`}>
      <span className="time tabular">{formatClock(position)}</span>
      <Slider
        className="thin"
        ariaLabel="播放进度"
        min={0}
        max={Math.max(duration, 1)}
        value={position}
        valueText={`${formatClock(position)} / ${formatClock(duration)}`}
        disabled={duration <= 0 || !!player.openingId}
        onCommit={player.seek}
      />
      <span className="time tabular">-{formatClock(Math.max(0, duration - position))}</span>
    </div>
  );
}

export function VolumeControl({ slider = true }: { slider?: boolean }) {
  const player = usePlayer();
  const volume = usePlayerStatus((status) => Math.round(status.volume));
  const Icon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  return (
    <div className="volume">
      <button className="icon-btn" title={volume > 0 ? "静音" : "取消静音"} aria-label={volume > 0 ? "静音" : "取消静音"} onClick={player.toggleMute}>
        <Icon size={16} />
      </button>
      {slider && <Slider className="volume-slider" ariaLabel="音量" min={0} max={100} value={volume} onCommit={player.setVolume} />}
    </div>
  );
}

/** Toolbar centre: transport and the "LCD" with artwork, title and progress. */
export function PlayerCenter() {
  const player = usePlayer();
  const file = player.nowPlaying && !player.isVideo ? player.nowPlaying : null;
  const fallback = file ? songParts(file) : null;
  const title = player.metadata?.title || fallback?.title || "";
  const artist = player.metadata?.artist || fallback?.artist || "";
  const album = player.metadata?.album || "";
  return (
    <div className="mini-player">
      <TransportButtons />
      <div className={`lcd ${file ? "" : "idle"}`}>
        {file ? (
          <>
            <button className="lcd-art" title="显示正在播放" aria-label="显示正在播放" onClick={() => player.setFullScreen(true)}>
              <Artwork url={player.metadata?.artworkUrl} size={38} />
            </button>
            <div className="lcd-body">
              <div className="lcd-title truncate" title={title}>
                {title}
              </div>
              <div className={`lcd-subtitle truncate ${player.error && !player.openingId ? "error" : ""}`}>
                {player.error && !player.openingId
                  ? player.error
                  : [artist || "未知艺人", album].filter(Boolean).join(" — ")}
              </div>
              <ProgressBar className="lcd-progress" />
            </div>
          </>
        ) : (
          <AudioWaveform className="lcd-logo" size={20} strokeWidth={1.6} />
        )}
      </div>
    </div>
  );
}

/** Toolbar trailing: volume and the lyrics / up next inspector toggles. */
export function PlayerTools() {
  const player = usePlayer();
  return (
    <div className="player-tools">
      <VolumeControl />
      <button
        className="icon-btn"
        aria-pressed={player.panel === "lyrics"}
        title="歌词"
        aria-label="歌词"
        onClick={() => player.togglePanel("lyrics")}
      >
        <MessageSquareQuote size={16} />
      </button>
      <button
        className="icon-btn"
        aria-pressed={player.panel === "queue"}
        title="待播清单"
        aria-label="待播清单"
        onClick={() => player.togglePanel("queue")}
      >
        <ListMusic size={17} />
      </button>
    </div>
  );
}
