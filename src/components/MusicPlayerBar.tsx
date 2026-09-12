import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  ListMusic,
  LoaderCircle,
  Mic2,
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  X,
} from "lucide-react";
import { formatTime, parseSyncedLyrics } from "../lib/media";
import {
  controlPlayer,
  getMusicMetadata,
  subscribePlayer,
  type MediaFile,
  type MusicMetadata,
  type PlayerStatus,
} from "../lib/nimbus";

export type MusicPlayMode = "sequence" | "repeat-all" | "repeat-one" | "shuffle";

type Props = {
  nowPlaying: MediaFile | null;
  playQueue: MediaFile[];
  openingId: string | null;
  onOpenFile: (file: MediaFile, fromStart?: boolean) => void;
  onStop: () => void;
  metadataLoader?: typeof getMusicMetadata;
  playerSubscriber?: typeof subscribePlayer;
};

export function MusicPlayerBar({ nowPlaying, playQueue, openingId, onOpenFile, onStop, metadataLoader = getMusicMetadata, playerSubscriber = subscribePlayer }: Props) {
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus>({
    running: false,
    paused: false,
    eofReached: false,
    position: 0,
    duration: 0,
    speed: 1,
    volume: 100,
    tracks: [],
  });

  const [localVolume, setLocalVolume] = useState(100);
  const draggingVolume = useRef(false);
  useEffect(() => {
    if (!draggingVolume.current) setLocalVolume(playerStatus.volume);
  }, [playerStatus.volume]);

  const [localPosition, setLocalPosition] = useState(0);
  const draggingProgress = useRef(false);
  useEffect(() => {
    if (!draggingProgress.current) setLocalPosition(playerStatus.position);
  }, [playerStatus.position]);

  const [musicMetadata, setMusicMetadata] = useState<MusicMetadata | null>(null);
  const [lyricsRevision, setLyricsRevision] = useState(0);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [musicExpanded, setMusicExpanded] = useState(false);
  const [playerMenu, setPlayerMenu] = useState<"songs" | null>(null);
  const [musicPlayMode, setMusicPlayMode] = useState<MusicPlayMode>(() => {
    const stored = localStorage.getItem("nimbus-music-play-mode");
    return stored === "sequence" || stored === "repeat-all" || stored === "repeat-one" || stored === "shuffle"
      ? (stored as MusicPlayMode)
      : "repeat-all";
  });

  const handledMusicEnd = useRef<string | null>(null);
  const [followLyrics, setFollowLyrics] = useState(true);
  const [fullLyrics, setFullLyrics] = useState(false);
  const lyricsPanel = useRef<HTMLDivElement>(null);

  // Subscribe to player state in this leaf component so position ticks don't re-render parent app
  useEffect(() => {
    return playerSubscriber((next) => {
      if (!next.fileId || next.fileId === nowPlaying?.id) {
        setPlayerStatus(next);
      }
    });
  }, [nowPlaying?.id, playerSubscriber]);

  useEffect(() => {
    localStorage.setItem("nimbus-music-play-mode", musicPlayMode);
  }, [musicPlayMode]);

  // Load music metadata
  useEffect(() => {
    if (nowPlaying?.mediaKind !== "music") {
      setMusicMetadata(null);
      setMusicExpanded(false);
      return;
    }
    setLyricsLoading(true);
    let cancelled = false;
    metadataLoader(nowPlaying.id, lyricsRevision > 0)
      .then((value) => {
        if (!cancelled) setMusicMetadata(value);
      })
      .catch(() => {
        if (!cancelled) {
          setMusicMetadata({ title: nowPlaying.displayName, artist: "", album: "" });
        }
      }).finally(() => { if (!cancelled) setLyricsLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [nowPlaying?.id, lyricsRevision, metadataLoader]);

  useEffect(() => {
    setMusicMetadata(null);
    setPlayerMenu(null);
    setFollowLyrics(true);
    setFullLyrics(false);
  }, [nowPlaying?.id]);

  // Auto-advance song on EOF
  useEffect(() => {
    if (nowPlaying?.mediaKind !== "music" || openingId || playerStatus.duration <= 0) return;
    if (!playerStatus.eofReached) {
      if (handledMusicEnd.current === nowPlaying.id) handledMusicEnd.current = null;
      return;
    }
    if (handledMusicEnd.current === nowPlaying.id) return;
    handledMusicEnd.current = nowPlaying.id;

    const index = playQueue.findIndex((file) => file.id === nowPlaying.id);
    let next: MediaFile | undefined;
    if (musicPlayMode === "repeat-one") next = nowPlaying;
    else if (index === -1) {
      void controlPlayer("stop");
      onStop();
      return;
    } else if (musicPlayMode === "shuffle") {
      next =
        playQueue.length > 1
          ? playQueue[(index + 1 + Math.floor(Math.random() * (playQueue.length - 1))) % playQueue.length]
          : nowPlaying;
    } else if (index >= 0 && index < playQueue.length - 1) {
      next = playQueue[index + 1];
    } else if (musicPlayMode === "repeat-all") {
      next = playQueue[0];
    }

    if (next) void onOpenFile(next, true);
    else {
      void controlPlayer("stop");
      onStop();
    }
  }, [
    musicPlayMode,
    nowPlaying,
    openingId,
    playQueue,
    playerStatus.duration,
    playerStatus.eofReached,
    playerStatus.position,
  ]);

  const lyricLines = useMemo(
    () => parseSyncedLyrics(musicMetadata?.syncedLyrics),
    [musicMetadata?.syncedLyrics]
  );

  const activeLyric = useMemo(
    () =>
      lyricLines.reduce(
        (active, line, index) => (playerStatus.position >= line.time ? index : active),
        -1
      ),
    [lyricLines, playerStatus.position]
  );

  useEffect(() => {
    const panel = lyricsPanel.current;
    if (!panel) return;
    const center = () => {
      panel.style.setProperty("--lyric-spacer", `${panel.clientHeight / 2}px`);
      if (!followLyrics || fullLyrics) return;
      const line = panel.querySelector<HTMLElement>(`[data-lyric="${Math.max(0, activeLyric)}"]`);
      if (line) panel.scrollTo({
        top: panel.scrollTop + line.getBoundingClientRect().top - panel.getBoundingClientRect().top
          - panel.clientHeight / 2 + line.offsetHeight / 2,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    };
    center();
    const observer = new ResizeObserver(center);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [activeLyric, musicExpanded, followLyrics, fullLyrics, lyricLines]);


  if (!nowPlaying || nowPlaying.mediaKind !== "music") return null;

  function stepMusic(direction: -1 | 1) {
    if (!nowPlaying || !playQueue.length) return;
    const index = playQueue.findIndex((file) => file.id === nowPlaying.id);
    if (index < 0) return;
    if (musicPlayMode === "shuffle" && playQueue.length > 1) {
      const offset = 1 + Math.floor(Math.random() * (playQueue.length - 1));
      void onOpenFile(playQueue[(index + offset) % playQueue.length], true);
      return;
    }
    const target = index + direction;
    if (target >= 0 && target < playQueue.length) void onOpenFile(playQueue[target], true);
    else if (musicPlayMode === "repeat-all") {
      void onOpenFile(playQueue[target < 0 ? playQueue.length - 1 : 0], true);
    }
  }

  const currentIndex = playQueue.findIndex((item) => item.id === nowPlaying.id);

  return (
    <>
      {musicExpanded && (
        <section className="apple-now-playing">
          <button
            className="icon-button close-now-playing"
            aria-label="收起正在播放"
            onClick={() => setMusicExpanded(false)}
          >
            <X size={20} />
          </button>
          <div className="now-artwork">
            {musicMetadata?.artworkUrl ? (
              <img src={musicMetadata.artworkUrl} alt="专辑封面" />
            ) : (
              <Music size={72} />
            )}
          </div>
          <div className="now-copy">
            <p>正在播放</p>
            <h2>{musicMetadata?.title || nowPlaying.displayName}</h2>
            <h3>{musicMetadata?.artist || "未知艺人"}</h3>
            <span>{musicMetadata?.album || "Nimbus 音乐库"}</span>
          </div>
          <div className="now-lyrics">
            <div className="lyric-heading">
              <Mic2 size={18} />
              <strong>歌词</strong>
              {lyricLines.length > 0 && <button className="lyrics-mode" aria-pressed={fullLyrics} onClick={() => {
                setFullLyrics(value => !value);
                setFollowLyrics(true);
                lyricsPanel.current?.scrollTo({ top: 0, behavior: "instant" });
              }}>{fullLyrics ? "同步歌词" : "查看全文"}</button>}
              <button className="lyrics-retry" disabled={lyricsLoading} onClick={() => setLyricsRevision(value => value + 1)}>{lyricsLoading ? "正在匹配…" : "重新匹配"}</button>
            </div>
            <div className={`lyric-scroll ${fullLyrics ? "lyrics-full" : ""}`} ref={lyricsPanel} tabIndex={0} aria-label="歌词，可滚动浏览"
              onWheel={() => setFollowLyrics(false)} onTouchStart={() => setFollowLyrics(false)}
              onKeyDown={event => { if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) setFollowLyrics(false); }}>
              {fullLyrics ? (
                (musicMetadata?.lyrics || lyricLines.map(line => line.text).join("\n"))
                  .split(/\r?\n/).map((line, index) => <span key={index}>{line || "\u00a0"}</span>)
              ) : lyricLines.length ? (
                lyricLines.map((line, index) => (
                  <button
                    data-lyric={index}
                    aria-current={index === activeLyric ? "true" : undefined}
                    className={`${index === activeLyric ? "active" : ""} ${
                      index < activeLyric ? "past" : ""
                    }`}
                    key={`${line.time}-${index}`}
                    onClick={() => controlPlayer("seek_absolute", line.time)}
                  >
                    {line.text}
                  </button>
                ))
              ) : musicMetadata?.lyrics ? (
                musicMetadata.lyrics
                  .split(/\r?\n/)
                  .filter(Boolean)
                  .map((line, index) => <span key={index}>{line}</span>)
              ) : (
                <span>{lyricsLoading ? "正在匹配歌词…" : "暂未匹配到歌词，可点击重新匹配"}</span>
              )}
            </div>
            {!fullLyrics && !followLyrics && lyricLines.length > 0 && <button className="lyrics-follow" onClick={() => setFollowLyrics(true)}>返回当前歌词</button>}
          </div>
        </section>
      )}

      <aside className="apple-music-player">
        <button className="apple-track" onClick={() => setMusicExpanded((value) => !value)}>
          <span className="apple-cover">
            {musicMetadata?.artworkUrl ? (
              <img src={musicMetadata.artworkUrl} alt="专辑封面" />
            ) : (
              <Music size={24} />
            )}
          </span>
          <span className="apple-track-copy">
            <strong>{musicMetadata?.title || nowPlaying.displayName}</strong>
            <small>
              {musicMetadata?.artist || "未知艺人"}
              {musicMetadata?.album ? ` · ${musicMetadata.album}` : ""}
            </small>
          </span>
        </button>

        <div className="apple-transport">
          <div className="apple-buttons">
            <button
              title="上一首"
              disabled={musicPlayMode === "sequence" && currentIndex <= 0}
              onClick={() => stepMusic(-1)}
            >
              <SkipBack size={18} fill="currentColor" />
            </button>
            <button
              className="apple-play"
              aria-label={playerStatus.paused ? "继续播放" : "暂停"}
              onClick={() => controlPlayer("play_pause")}
            >
              {playerStatus.paused ? (
                <Play size={22} fill="currentColor" />
              ) : (
                <Pause size={22} fill="currentColor" />
              )}
            </button>
            <button
              title="下一首"
              disabled={musicPlayMode === "sequence" && currentIndex >= playQueue.length - 1}
              onClick={() => stepMusic(1)}
            >
              <SkipForward size={18} fill="currentColor" />
            </button>
          </div>
          <div className="apple-progress">
            <span>{formatTime(playerStatus.position)}</span>
            <input
              aria-label="播放进度"
              type="range"
              min="0"
              max={Math.max(playerStatus.duration, 1)}
              value={Math.min(localPosition, Math.max(playerStatus.duration, 1))}
              onChange={(event) => {
                draggingProgress.current = true;
                setLocalPosition(Number(event.target.value));
              }}
              onPointerUp={() => {
                draggingProgress.current = false;
                void controlPlayer("seek_absolute", localPosition);
              }}
              onMouseUp={() => {
                draggingProgress.current = false;
                void controlPlayer("seek_absolute", localPosition);
              }}
            />
            <span>{formatTime(playerStatus.duration)}</span>
          </div>
        </div>

        <div className="apple-tools">
          <label className="apple-mode-select" title="点击选择播放方式">
            {musicPlayMode === "shuffle" ? (
              <Shuffle size={18} />
            ) : musicPlayMode === "repeat-one" ? (
              <Repeat1 size={18} />
            ) : (
              <Repeat size={18} />
            )}
            <span>
              {musicPlayMode === "sequence"
                ? "顺序"
                : musicPlayMode === "repeat-all"
                ? "列表循环"
                : musicPlayMode === "repeat-one"
                ? "单曲循环"
                : "随机"}
            </span>
            <select
              aria-label="播放方式"
              value={musicPlayMode}
              onChange={(event) => setMusicPlayMode(event.target.value as MusicPlayMode)}
            >
              <option value="sequence">顺序播放</option>
              <option value="repeat-all">列表循环</option>
              <option value="repeat-one">单曲循环</option>
              <option value="shuffle">随机播放</option>
            </select>
          </label>
          <button
            className={musicExpanded ? "active" : ""}
            title="歌词"
            onClick={() => setMusicExpanded((value) => !value)}
          >
            <Mic2 size={19} />
          </button>
          <div className="player-menu-anchor">
            <button
              className={playerMenu === "songs" ? "active" : ""}
              title="播放队列"
              onClick={() => setPlayerMenu((value) => (value === "songs" ? null : "songs"))}
            >
              <ListMusic size={20} />
            </button>
            {playerMenu === "songs" && (
              <div className="player-menu-popover song-menu">
                <header>
                  <strong>播放队列</strong>
                  <span>{playQueue.length} 首</span>
                </header>
                <div className="player-menu-list">
                  {playQueue.map((file, index) => (
                    <button
                      className={file.id === nowPlaying.id ? "current" : ""}
                      key={file.id}
                      onClick={() => {
                        setPlayerMenu(null);
                        void onOpenFile(file, true);
                      }}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{file.displayName.replace(/\.[^.]+$/, "")}</strong>
                      {file.id === nowPlaying.id && <i>播放中</i>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <Volume2 size={20} />
          <input
            className="apple-volume"
            aria-label="音量"
            type="range"
            min="0"
            max="100"
            value={localVolume}
            onChange={(event) => {
              draggingVolume.current = true;
              setLocalVolume(Number(event.target.value));
            }}
            onPointerUp={() => {
              draggingVolume.current = false;
              void controlPlayer("volume", localVolume);
            }}
            onMouseUp={() => {
              draggingVolume.current = false;
              void controlPlayer("volume", localVolume);
            }}
          />
          <button
            className="icon-button close-music-bar"
            title="关闭底栏"
            aria-label="关闭底栏"
            onClick={() => {
              void controlPlayer("stop");
              onStop();
            }}
          >
            <X size={16} />
          </button>
        </div>
      </aside>
    </>
  );
}
