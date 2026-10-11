import { useEffect, useMemo, useRef, useState } from "react";
import { ListVideo, LoaderCircle, Pause, Play, Volume1, Volume2, VolumeX } from "lucide-react";
import { buildMovieWorks, cleanWorkTitle, compareSeasons, episodeLabel, episodeOf, seasonLabel, seasonOf, uniqueEpisodes } from "../lib/media";
import { formatClock } from "../lib/format";
import { isEditableTarget, onMenuAction, showContextMenu, type MenuEntry } from "../lib/native";
import {
  controlPlayer,
  getCachedAiSubtitles,
  getCurrentPlayerFile,
  getPlayerPlaylist,
  getPlayerStatus,
  listMediaFiles,
  openNativePlayer,
  setNowPlayingInfo,
  subscribePlayer,
  type MediaFile,
  type PlayerStatus,
} from "../lib/nimbus";
import { Slider } from "../ui/controls";
import { isModalOpen, useTopmostEscape } from "../ui/Sheet";
import { AiSubtitlesSheet } from "./AiSubtitlesSheet";
import { EMPTY_STATUS } from "./statusStore";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** SF Symbols-style "go backward / forward 10 seconds" glyph. */
function SkipIcon({ forward }: { forward?: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g transform={forward ? undefined : "translate(24 0) scale(-1 1)"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
        <path d="M9.6 1.4 12 3.5 9.6 5.6" />
      </g>
      <text x="12" y="12.6" textAnchor="middle" dominantBaseline="middle" fontSize="7.4" fontWeight="700" fill="currentColor">
        10
      </text>
    </svg>
  );
}

/** Episode picker that opens above the controls: seasons as tabs, episodes as a grid. */
function EpisodePanel({
  queue,
  current,
  isSeries,
  switching,
  onPick,
  onClose,
}: {
  queue: MediaFile[];
  current: MediaFile;
  isSeries: boolean;
  switching: boolean;
  onPick: (file: MediaFile) => void;
  onClose: () => void;
}) {
  const seasons = useMemo(() => [...new Set(queue.map(seasonOf))].sort(compareSeasons), [queue]);
  const [season, setSeason] = useState(() => seasonOf(current));
  const list = useRef<HTMLDivElement>(null);
  useTopmostEscape(true, onClose);
  const shown = seasons.length > 1 ? queue.filter((file) => seasonOf(file) === season) : queue;
  const numbered = isSeries && shown.every((file) => (episodeOf(file) ?? 0) > 0);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>("[aria-current='true']")?.scrollIntoView({ block: "nearest" });
  }, [season]);

  return (
    <div className="episode-panel" role="dialog" aria-label={isSeries ? "选集" : "播放列表"}>
      <div className="episode-header">
        <strong>{isSeries ? "选集" : "播放列表"}</strong>
        <span>{isSeries ? `共 ${shown.length} 集` : `${queue.length} 个视频`}</span>
      </div>
      {seasons.length > 1 && (
        <div className="episode-seasons" role="tablist" aria-label="季">
          {seasons.map((item) => (
            <button key={item} role="tab" aria-selected={item === season} onClick={() => setSeason(item)}>
              {seasonLabel(item)}
            </button>
          ))}
        </div>
      )}
      <div ref={list} className={numbered ? "episode-grid" : "episode-list"}>
        {shown.map((file) => {
          const position = queue.indexOf(file);
          const name = cleanWorkTitle(file.displayName) || file.displayName;
          const isCurrent = file.id === current.id;
          return (
            <button
              key={file.id}
              aria-current={isCurrent}
              disabled={switching}
              title={isSeries ? `${episodeLabel(file, position)} · ${file.displayName}` : file.displayName}
              onClick={() => (isCurrent ? onClose() : onPick(file))}
            >
              {numbered ? episodeOf(file) : <span className="truncate">{isSeries ? episodeLabel(file, position) : name}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Transparent window that floats QuickTime-style controls over the native libmpv view. */
export function VideoOverlay() {
  const [current, setCurrent] = useState<MediaFile | null>(null);
  const currentId = useRef<string | null>(null);
  currentId.current = current?.id ?? null;
  const [allFiles, setAllFiles] = useState<MediaFile[]>([]);
  const [playlist, setPlaylist] = useState<MediaFile[]>([]);
  const [status, setStatus] = useState<PlayerStatus>(EMPTY_STATUS);
  const previousVolume = useRef(100);
  const [interacting, setInteracting] = useState(false);
  const endedFile = useRef<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [visible, setVisible] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [cachedSrt, setCachedSrt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hideTimer = useRef<number>();
  const clickTimer = useRef<number>();
  const switchRequest = useRef(0);

  useEffect(() => {
    if (status.volume > 0) previousVolume.current = status.volume;
  }, [status.volume]);
  useEffect(() => () => window.clearTimeout(clickTimer.current), []);

  // Follow the player; only resolve file details when the file changes.
  useEffect(() => {
    let resolvedId: string | null = null;
    let pending = false;
    let disposed = false;
    const resolve = (next: PlayerStatus) => {
      if (disposed) return;
      setStatus(next);
      const id = next.fileId ?? null;
      if (!id) {
        resolvedId = null;
        setCurrent(null);
        return;
      }
      if (resolvedId === id || pending) return;
      pending = true;
      void getCurrentPlayerFile()
        .then((file) => {
          if (!disposed && file?.id === id) {
            resolvedId = id;
            setCurrent(file);
          }
        })
        .catch((cause) => {
          if (!disposed) setError(String(cause));
        })
        .finally(() => {
          pending = false;
        });
    };
    const off = subscribePlayer(resolve);
    const recover = () => void getPlayerStatus().then(resolve).catch(() => undefined);
    window.addEventListener("focus", recover);
    recover();
    return () => {
      disposed = true;
      off();
      window.removeEventListener("focus", recover);
    };
  }, []);

  useEffect(() => {
    if (!current) return;
    void listMediaFiles().then(setAllFiles).catch(() => undefined);
    void getPlayerPlaylist().then(setPlaylist).catch(() => undefined);
    const id = current.id;
    setCachedSrt(null);
    void getCachedAiSubtitles(id)
      .then((path) => {
        if (currentId.current === id) setCachedSrt(path);
      })
      .catch(() => undefined);
  }, [current?.id]);

  // Folder playlists win when playing from Files; otherwise the series the file belongs to.
  const { queue, work } = useMemo(() => {
    if (!current) return { queue: [] as MediaFile[], work: null };
    const found = buildMovieWorks(allFiles.filter((file) => file.mediaKind === "movie")).find((item) =>
      item.files.some((file) => file.id === current.id),
    );
    if (playlist.length > 1 && playlist.some((file) => file.id === current.id)) return { queue: playlist, work: found ?? null };
    if (!found?.isSeries) return { queue: playlist.length ? playlist : [current], work: found ?? null };
    const episodes = uniqueEpisodes(found.files).map((file) =>
      seasonOf(file) === seasonOf(current) && episodeOf(file) === episodeOf(current) ? current : file,
    );
    return { queue: episodes, work: found };
  }, [allFiles, current, playlist]);

  const seasons = useMemo(() => [...new Set(queue.map(seasonOf))].sort(compareSeasons), [queue]);
  const index = queue.findIndex((file) => file.id === current?.id);
  const isSeries = !!work?.isSeries;
  const title = work?.title || (current ? cleanWorkTitle(current.displayName) || current.displayName : "");
  const subtitle =
    current && isSeries
      ? `${seasons.length > 1 ? `${seasonLabel(seasonOf(current))} · ` : ""}${episodeLabel(current, Math.max(index, 0))}`
      : "";

  useEffect(() => {
    if (current) void setNowPlayingInfo({ fileId: current.id, title, album: subtitle }).catch(() => undefined);
  }, [current?.id, title, subtitle]);

  // Controls stay visible while paused, at the end, or while being used.
  useEffect(() => {
    const reveal = () => {
      setVisible(true);
      window.clearTimeout(hideTimer.current);
      if (!aiOpen && !episodesOpen && !status.paused && !status.eofReached && !interacting) {
        hideTimer.current = window.setTimeout(() => setVisible(false), 3000);
      }
    };
    reveal();
    window.addEventListener("mousemove", reveal);
    window.addEventListener("pointerdown", reveal);
    window.addEventListener("keydown", reveal);
    return () => {
      window.removeEventListener("mousemove", reveal);
      window.removeEventListener("pointerdown", reveal);
      window.removeEventListener("keydown", reveal);
      window.clearTimeout(hideTimer.current);
    };
  }, [aiOpen, episodesOpen, status.paused, status.eofReached, interacting]);

  const switchEpisode = async (file: MediaFile) => {
    if (switching) return;
    setSwitching(true);
    const request = ++switchRequest.current;
    setError(null);
    try {
      await openNativePlayer(file.id, true);
      const next = await getPlayerStatus();
      if (request === switchRequest.current && next.fileId === file.id) {
        setCurrent(file);
        setStatus(next);
      }
    } catch (cause) {
      if (request === switchRequest.current) setError(String(cause));
    } finally {
      if (request === switchRequest.current) setSwitching(false);
    }
  };

  const latest = useRef({ status, index, queue, switching, current });
  latest.current = { status, index, queue, switching, current };

  const step = (direction: -1 | 1) => {
    const { index: position, queue: items, switching: busy } = latest.current;
    const target = items[position + direction];
    if (!busy && position >= 0 && target) void switchEpisode(target);
  };
  const volume = (value: number) => void controlPlayer("volume", Math.max(0, Math.min(100, Math.round(value))));
  const toggleMute = () => volume(latest.current.status.volume > 0 ? 0 : previousVolume.current);
  const togglePlay = () => {
    const { status: now, current: file } = latest.current;
    if (now.eofReached && file) void switchEpisode(file);
    else void controlPlayer("play_pause");
  };

  // Next episode when a video ends.
  useEffect(() => {
    if (!status.eofReached) {
      endedFile.current = null;
      return;
    }
    if (queue.length > 1 && current && status.fileId === current.id && endedFile.current !== current.id && !switching) {
      endedFile.current = current.id;
      const position = queue.findIndex((file) => file.id === current.id);
      if (position >= 0 && position < queue.length - 1) void switchEpisode(queue[position + 1]);
    }
  }, [status.eofReached, queue, current?.id]);

  // Keyboard: the same keys as QuickTime and IINA.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isModalOpen()) return;
        event.preventDefault();
        void controlPlayer("exit_fullscreen");
        return;
      }
      if (aiOpen || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
      // Sliders and pop-ups handle their own arrow keys.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      const actions: Record<string, () => void> = {
        Space: togglePlay,
        KeyK: togglePlay,
        ArrowLeft: () => void controlPlayer("seek", -5),
        ArrowRight: () => void controlPlayer("seek", 5),
        KeyJ: () => void controlPlayer("seek", -10),
        KeyL: () => void controlPlayer("seek", 10),
        ArrowUp: () => volume(latest.current.status.volume + 5),
        ArrowDown: () => volume(latest.current.status.volume - 5),
        KeyM: toggleMute,
        KeyF: () => void controlPlayer("fullscreen"),
      };
      const action = actions[event.code];
      if (!action) return;
      if (event.target instanceof HTMLButtonElement && event.code === "Space") return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aiOpen]);

  // Menu bar and media keys.
  useEffect(
    () =>
      onMenuAction((id) => {
        if (!latest.current.current) return;
        if (id === "cove.play-pause") togglePlay();
        else if (id === "cove.next") step(1);
        else if (id === "cove.previous") step(-1);
        else if (id === "cove.volume-up") volume(latest.current.status.volume + 10);
        else if (id === "cove.volume-down") volume(latest.current.status.volume - 10);
        else if (id === "cove.stop") void controlPlayer("stop");
      }),
    [],
  );

  if (!current) {
    return (
      <main className="video-overlay visible loading">
        <div className="video-status">
          {error ? (
            <p>{error}</p>
          ) : (
            <>
              <LoaderCircle className="spin" size={22} />
              <p>正在准备播放…</p>
            </>
          )}
        </div>
      </main>
    );
  }

  const audioTracks = status.tracks.filter((track) => track.kind === "audio");
  const subtitleTracks = status.tracks.filter((track) => track.kind === "sub");
  const VolumeIcon = status.volume === 0 ? VolumeX : status.volume < 50 ? Volume1 : Volume2;
  const shownError = error || status.error;
  const trackName = (track: { id: number; title: string; language: string }, fallback: string) =>
    [track.title, track.language].filter((value) => value && value !== "未命名轨道").join(" · ") || `${fallback} ${track.id}`;

  const episodeItem = (file: MediaFile, position: number): MenuEntry => ({
    label: isSeries && (episodeOf(file) ?? 0) > 0 ? episodeLabel(file, position) : cleanWorkTitle(file.displayName) || file.displayName,
    checked: file.id === current.id,
    action: () => void switchEpisode(file),
  });

  /** Everything beyond play/pause lives in a native right-click menu, as in IINA and QuickTime. */
  const videoMenu = (event: React.MouseEvent) => {
    const episodes: MenuEntry[] =
      seasons.length > 1
        ? seasons.map((season) => ({
            label: seasonLabel(season),
            submenu: queue.filter((file) => seasonOf(file) === season).map(episodeItem),
          }))
        : queue.map(episodeItem);
    void showContextMenu(event, [
      { label: status.paused || status.eofReached ? "播放" : "暂停", action: togglePlay },
      "separator",
      ...(queue.length > 1 ? [{ label: isSeries ? "选集" : "同一文件夹", submenu: episodes }] : []),
      {
        label: "播放速度",
        submenu: SPEEDS.map((speed) => ({
          label: speed === 1 ? "正常" : `${speed}×`,
          checked: Math.abs(status.speed - speed) < 0.01,
          action: () => void controlPlayer("speed", speed),
        })),
      },
      ...(audioTracks.length > 1
        ? [
            {
              label: "音轨",
              submenu: audioTracks.map((track) => ({
                label: trackName(track, "音轨"),
                checked: track.selected,
                action: () => void controlPlayer("audio", track.id),
              })),
            },
          ]
        : []),
      {
        label: "字幕",
        submenu: [
          { label: "关闭", checked: !subtitleTracks.some((track) => track.selected), action: () => void controlPlayer("subtitle", -1) },
          ...subtitleTracks.map((track) => ({
            label: trackName(track, "字幕"),
            checked: track.selected,
            action: () => void controlPlayer("subtitle", track.id),
          })),
          "separator",
          { label: cachedSrt ? "重新生成 AI 字幕…" : "生成 AI 字幕…", action: () => setAiOpen(true) },
        ],
      },
      "separator",
      { label: "全屏", action: () => void controlPlayer("fullscreen") },
      { label: "停止播放", action: () => void controlPlayer("stop") },
    ]);
  };

  return (
    <main className={`video-overlay ${visible ? "visible" : "idle"}`} onContextMenu={videoMenu}>
      <div
        className="video-surface"
        aria-hidden="true"
        onClick={(event) => {
          // The first click outside the episode picker only closes it.
          if (episodesOpen) {
            setEpisodesOpen(false);
            return;
          }
          if (event.detail === 1) {
            window.clearTimeout(clickTimer.current);
            clickTimer.current = window.setTimeout(togglePlay, 240);
          }
        }}
        onDoubleClick={() => {
          window.clearTimeout(clickTimer.current);
          void controlPlayer("fullscreen");
        }}
      />

      <div className="video-title">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>

      {shownError && (
        <div className="video-error" role="alert">
          {shownError}
        </div>
      )}

      <section
        className="video-hud"
        onPointerEnter={() => setInteracting(true)}
        onPointerLeave={() => setInteracting(false)}
        onFocusCapture={() => setInteracting(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setInteracting(false);
        }}
      >
        <div className="hud-row">
          <div className="hud-group">
            <button className="hud-icon" title={status.volume > 0 ? "静音 (M)" : "取消静音 (M)"} onClick={toggleMute}>
              <VolumeIcon size={17} />
            </button>
            <Slider className="hud-volume" ariaLabel="音量" min={0} max={100} value={status.volume} onCommit={volume} />
          </div>
          <div className="hud-group center">
            <button className="hud-icon" title="后退 10 秒 (J)" aria-label="后退 10 秒" onClick={() => void controlPlayer("seek", -10)}>
              <SkipIcon />
            </button>
            <button
              className="hud-icon play"
              title={status.paused || status.eofReached ? "播放 (空格)" : "暂停 (空格)"}
              disabled={switching}
              onClick={togglePlay}
            >
              {switching ? (
                <LoaderCircle className="spin" size={22} />
              ) : status.paused || status.eofReached ? (
                <Play size={24} fill="currentColor" strokeWidth={0} />
              ) : (
                <Pause size={24} fill="currentColor" strokeWidth={0} />
              )}
            </button>
            <button className="hud-icon" title="前进 10 秒 (L)" aria-label="前进 10 秒" onClick={() => void controlPlayer("seek", 10)}>
              <SkipIcon forward />
            </button>
          </div>
          <div className="hud-group end">
            {queue.length > 1 && (
              <button
                className={`hud-text-button ${episodesOpen ? "active" : ""}`}
                aria-expanded={episodesOpen}
                title={isSeries ? "选集" : "同一文件夹中的视频"}
                onClick={() => setEpisodesOpen((open) => !open)}
              >
                <ListVideo size={16} />
                {isSeries ? "选集" : "列表"}
              </button>
            )}
          </div>
        </div>
        <div className="hud-progress">
          <span className="tabular">{formatClock(status.position)}</span>
          <Slider
            ariaLabel="播放进度"
            min={0}
            max={Math.max(status.duration, 1)}
            value={status.position}
            disabled={status.duration <= 0 || switching}
            onCommit={(value) => void controlPlayer("seek_absolute", value)}
          />
          <span className="tabular">-{formatClock(Math.max(0, status.duration - status.position))}</span>
        </div>
      </section>

      {episodesOpen && queue.length > 1 && (
        <EpisodePanel
          queue={queue}
          current={current}
          isSeries={isSeries}
          switching={switching}
          onClose={() => setEpisodesOpen(false)}
          onPick={(file) => {
            setEpisodesOpen(false);
            void switchEpisode(file);
          }}
        />
      )}

      {aiOpen && (
        <AiSubtitlesSheet
          file={current}
          cached={!!cachedSrt}
          onClose={() => setAiOpen(false)}
          onGenerated={(fileId, path) => {
            if (currentId.current === fileId) setCachedSrt(path);
          }}
        />
      )}
    </main>
  );
}
