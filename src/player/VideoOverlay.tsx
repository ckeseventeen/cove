import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Captions,
  ChevronLeft,
  Gauge,
  ListVideo,
  LoaderCircle,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipBack,
  SkipForward,
  Sparkles,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { buildMovieWorks, cleanWorkTitle, episodeLabel, episodeOf, seasonOf, uniqueEpisodes } from "../lib/media";
import { formatClock } from "../lib/format";
import { isEditableTarget, onMenuAction } from "../lib/native";
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
import { Segmented, Slider } from "../ui/controls";
import { isModalOpen } from "../ui/Sheet";
import { AiSubtitlesSheet } from "./AiSubtitlesSheet";
import { EMPTY_STATUS } from "./statusStore";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [drawerSeason, setDrawerSeason] = useState(1);
  const [aiOpen, setAiOpen] = useState(false);
  const [cachedSrt, setCachedSrt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hideTimer = useRef<number>();
  const clickTimer = useRef<number>();
  const switchRequest = useRef(0);
  const activeEpisode = useRef<HTMLButtonElement>(null);

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

  const seasons = useMemo(() => [...new Set(queue.map(seasonOf))].sort((left, right) => left - right), [queue]);
  const index = queue.findIndex((file) => file.id === current?.id);
  const isSeries = !!work?.isSeries;
  const title = work?.title || (current ? cleanWorkTitle(current.displayName) || current.displayName : "");
  const subtitle =
    current && isSeries
      ? `${seasons.length > 1 ? `第 ${seasonOf(current)} 季 · ` : ""}${episodeLabel(current, Math.max(index, 0))}`
      : "";

  useEffect(() => {
    if (current) void setNowPlayingInfo({ fileId: current.id, title, album: subtitle }).catch(() => undefined);
  }, [current?.id, title, subtitle]);

  useEffect(() => {
    if (current && seasons.length) setDrawerSeason(seasonOf(current));
  }, [current?.id, seasons.join(",")]);

  useEffect(() => {
    if (episodesOpen) activeEpisode.current?.scrollIntoView({ block: "center" });
  }, [current?.id, episodesOpen, drawerSeason]);

  // Controls stay visible while paused, at the end, or while being used.
  useEffect(() => {
    const reveal = () => {
      setVisible(true);
      window.clearTimeout(hideTimer.current);
      if (!episodesOpen && !aiOpen && !settingsOpen && !status.paused && !status.eofReached && !interacting) {
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
  }, [episodesOpen, aiOpen, settingsOpen, status.paused, status.eofReached, interacting]);

  const switchEpisode = async (file: MediaFile) => {
    if (switching) return;
    setSwitching(true);
    setEpisodesOpen(false);
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
        if (episodesOpen) setEpisodesOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else void controlPlayer("exit_fullscreen");
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
  }, [episodesOpen, aiOpen, settingsOpen]);

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

  const back = (
    <button className="hud-pill" title="停止播放并返回资料库" onClick={() => void controlPlayer("stop")}>
      <ChevronLeft size={15} />
      返回
    </button>
  );

  if (!current) {
    return (
      <main className="video-overlay visible loading">
        <div className="video-top">{back}</div>
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

  return (
    <main className={`video-overlay ${visible ? "visible" : "idle"}`}>
      <div
        className="video-surface"
        aria-hidden="true"
        onClick={(event) => {
          if (settingsOpen) {
            setSettingsOpen(false);
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

      <div className="video-top">
        {back}
        <div className="video-title">
          <strong>{title}</strong>
          {subtitle && <span>{subtitle}</span>}
        </div>
      </div>

      {shownError && (
        <div className="video-error" role="alert">
          {shownError}
        </div>
      )}

      {episodesOpen && (
        <>
          <button className="video-dismiss" aria-label="关闭选集" onClick={() => setEpisodesOpen(false)} />
          <aside className="hud-panel episodes" aria-label="选集">
            <header>
              <strong>{isSeries ? "选集" : "同一文件夹"}</strong>
              <span>{queue.length} 个视频</span>
              <button className="hud-icon" aria-label="关闭选集" onClick={() => setEpisodesOpen(false)}>
                <X size={14} />
              </button>
            </header>
            {seasons.length > 1 && (
              <div className="episodes-seasons">
                <Segmented<string>
                  ariaLabel="季"
                  value={String(drawerSeason)}
                  onChange={(value) => setDrawerSeason(Number(value))}
                  options={seasons.map((season) => ({ value: String(season), label: `第 ${season} 季` }))}
                />
              </div>
            )}
            <div className="episodes-list">
              {queue
                .filter((file) => (seasons.length > 1 ? seasonOf(file) === drawerSeason : true))
                .map((file, position) => {
                  const active = file.id === current.id;
                  const label = isSeries && (episodeOf(file) ?? 0) > 0 ? episodeLabel(file, position) : cleanWorkTitle(file.displayName) || file.displayName;
                  return (
                    <button
                      key={file.id}
                      ref={active ? activeEpisode : undefined}
                      className={`episode-item ${active ? "active" : ""}`}
                      title={file.displayName}
                      onClick={() => void switchEpisode(file)}
                    >
                      <span className="truncate">{label}</span>
                      {active && <AudioLines size={13} />}
                    </button>
                  );
                })}
            </div>
          </aside>
        </>
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
            {queue.length > 1 && (
              <button className="hud-icon" title="上一个" disabled={switching || index <= 0} onClick={() => step(-1)}>
                <SkipBack size={17} fill="currentColor" strokeWidth={0} />
              </button>
            )}
            <button className="hud-icon" title="后退 10 秒" onClick={() => void controlPlayer("seek", -10)}>
              <RotateCcw size={17} />
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
            <button className="hud-icon" title="前进 10 秒" onClick={() => void controlPlayer("seek", 10)}>
              <RotateCw size={17} />
            </button>
            {queue.length > 1 && (
              <button className="hud-icon" title="下一个" disabled={switching || index < 0 || index >= queue.length - 1} onClick={() => step(1)}>
                <SkipForward size={17} fill="currentColor" strokeWidth={0} />
              </button>
            )}
          </div>
          <div className="hud-group end">
            {queue.length > 1 && (
              <button
                className={`hud-icon ${episodesOpen ? "active" : ""}`}
                title="选集"
                onClick={() => {
                  setEpisodesOpen((value) => !value);
                  setSettingsOpen(false);
                }}
              >
                <ListVideo size={17} />
              </button>
            )}
            <div className="hud-anchor">
              <button
                className={`hud-icon ${settingsOpen ? "active" : ""}`}
                title="播放设置"
                aria-expanded={settingsOpen}
                onClick={() => {
                  setSettingsOpen((value) => !value);
                  setEpisodesOpen(false);
                }}
              >
                <Settings2 size={17} />
              </button>
              {settingsOpen && (
                <div className="hud-panel settings" role="dialog" aria-label="播放设置">
                  <label className="hud-setting">
                    <Gauge size={15} />
                    <span>速度</span>
                    <select aria-label="播放速度" value={status.speed} onChange={(event) => void controlPlayer("speed", Number(event.target.value))}>
                      {SPEEDS.map((speed) => (
                        <option key={speed} value={speed}>
                          {speed === 1 ? "正常" : `${speed}×`}
                        </option>
                      ))}
                    </select>
                  </label>
                  {audioTracks.length > 0 && (
                    <label className="hud-setting">
                      <AudioLines size={15} />
                      <span>音轨</span>
                      <select
                        aria-label="音轨"
                        value={audioTracks.find((track) => track.selected)?.id ?? -1}
                        onChange={(event) => void controlPlayer("audio", Number(event.target.value))}
                      >
                        {audioTracks.map((track) => (
                          <option value={track.id} key={track.id}>
                            {track.title || track.language || `音轨 ${track.id}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="hud-setting">
                    <Captions size={15} />
                    <span>字幕</span>
                    <select
                      aria-label="字幕"
                      value={subtitleTracks.find((track) => track.selected)?.id ?? -1}
                      onChange={(event) => void controlPlayer("subtitle", Number(event.target.value))}
                    >
                      <option value="-1">关闭</option>
                      {subtitleTracks.map((track) => (
                        <option value={track.id} key={track.id}>
                          {track.title || track.language || "字幕"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="hud-setting action"
                    onClick={() => {
                      setAiOpen(true);
                      setSettingsOpen(false);
                    }}
                  >
                    <Sparkles size={15} />
                    <span>{cachedSrt ? "重新生成 AI 字幕…" : "生成 AI 字幕…"}</span>
                  </button>
                </div>
              )}
            </div>
            <button className="hud-icon" title="全屏 (F)" onClick={() => void controlPlayer("fullscreen")}>
              <Maximize size={16} />
            </button>
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
