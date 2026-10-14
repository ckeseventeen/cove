import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { songParts } from "../lib/media";
import {
  controlPlayer,
  getCurrentPlayerFile,
  getMusicMetadata,
  getPlayerPlaylist,
  isOpenCancelled,
  onPlayerError,
  onPlayerStopped,
  openNativePlayer,
  setNowPlayingInfo,
  type MediaFile,
  type MusicMetadata,
  type RecentPlayback,
} from "../lib/nimbus";
import { nextQueueIndex, shuffleUpcoming, unmuteVolume, type RepeatMode } from "../lib/playback";
import type { Notify } from "../ui/Toasts";
import { onStatus, readStatus } from "./statusStore";

export type PanelKind = "lyrics" | "queue";
type OpenOptions = { queue?: MediaFile[]; fromStart?: boolean; keepQueue?: boolean; resume?: boolean };
type Resume = { position: number; duration: number };

const SESSION_KEY = "cove-music-session";

export type PlayerApi = {
  nowPlaying: MediaFile | null;
  isVideo: boolean;
  openingId: string | null;
  queue: MediaFile[];
  currentIndex: number;
  repeat: RepeatMode;
  shuffle: boolean;
  metadata: MusicMetadata | null;
  metadataLoading: boolean;
  error: string;
  /** What the lyrics / up next buttons show: the inspector, or the right side of Now Playing while it is open. */
  panel: PanelKind | null;
  fullScreen: boolean;
  /** A song restored from the last session: shown paused, resumes from here. */
  resumeAt: Resume | null;
  play: (file: MediaFile, options?: OpenOptions) => Promise<void>;
  playShuffled: (files: MediaFile[]) => void;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
  setVolume: (volume: number) => void;
  changeVolume: (delta: number) => void;
  toggleMute: () => void;
  stop: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  moveInQueue: (index: number, delta: -1 | 1) => void;
  removeFromQueue: (id: string) => void;
  playNext: (files: MediaFile | MediaFile[]) => void;
  addToQueue: (files: MediaFile | MediaFile[]) => void;
  clearUpcoming: () => void;
  refreshMetadata: () => void;
  togglePanel: (panel: PanelKind) => void;
  setPanel: (panel: PanelKind | null) => void;
  setFullScreen: (open: boolean) => void;
};

const PlayerContext = createContext<PlayerApi | null>(null);

export function usePlayer() {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("usePlayer must be used inside PlayerProvider");
  return value;
}

function initialRepeat(): RepeatMode {
  try {
    const saved = localStorage.getItem("cove-repeat");
    if (saved === "one" || saved === "all" || saved === "off") return saved;
    const legacy = localStorage.getItem("nimbus-music-play-mode");
    return legacy === "repeat-one" ? "one" : legacy === "repeat-all" ? "all" : "off";
  } catch {
    return "off";
  }
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const isMusic = (file: MediaFile | null) => file?.mediaKind === "music";

export function PlayerProvider({
  children,
  notify,
  onPlaybackStarted,
  songs = [],
  recent = [],
  loaded = false,
}: {
  children: ReactNode;
  notify: Notify;
  onPlaybackStarted?: () => void;
  /** Library songs and saved positions, used to restore the last session. */
  songs?: MediaFile[];
  recent?: RecentPlayback[];
  loaded?: boolean;
}) {
  const [nowPlaying, setNowPlaying] = useState<MediaFile | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [queue, setQueue] = useState<MediaFile[]>([]);
  const [repeat, setRepeat] = useState<RepeatMode>(initialRepeat);
  const [shuffle, setShuffle] = useState(false);
  const [metadata, setMetadata] = useState<MusicMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataRevision, setMetadataRevision] = useState(0);
  const [error, setError] = useState("");
  const [inspector, setInspector] = useState<PanelKind | null>(null);
  const [fullPanel, setFullPanel] = useState<PanelKind | null>("lyrics");
  const [fullScreen, setFullScreen] = useState(false);
  const [resumeAt, setResumeAt] = useState<Resume | null>(null);
  const restoreAttempted = useRef(false);

  const generation = useRef(0);
  const originalOrder = useRef<string[]>([]);
  const previousVolume = useRef(70);
  const handledEnd = useRef<string | null>(null);
  const lastBackendId = useRef<string | null | undefined>(undefined);
  const refreshRequested = useRef(false);
  const metadataFor = useRef<string | null>(null);
  const started = useRef(onPlaybackStarted);
  started.current = onPlaybackStarted;
  const latest = useRef({ nowPlaying, queue, repeat, openingId });
  latest.current = { nowPlaying, queue, repeat, openingId };

  const currentIndex = nowPlaying ? queue.findIndex((file) => file.id === nowPlaying.id) : -1;
  const isVideo = !!nowPlaying && !isMusic(nowPlaying);

  useEffect(() => {
    try {
      localStorage.setItem("cove-repeat", repeat);
    } catch {
      // Preference persistence is best effort.
    }
  }, [repeat]);

  const command = useCallback((action: string, value?: number) => {
    setError("");
    void controlPlayer(action, value).catch((cause) => setError(errorText(cause)));
  }, []);

  const play = useCallback(
    async (file: MediaFile, { queue: candidates, fromStart = false, keepQueue = false, resume = false }: OpenOptions = {}) => {
      const request = ++generation.current;
      setOpeningId(file.id);
      setError("");
      const music = isMusic(file);
      if (music) {
        if (!keepQueue) {
          setQueue(candidates?.some((item) => item.id === file.id) ? [...candidates] : [file]);
          setShuffle(false);
          originalOrder.current = [];
        }
        handledEnd.current = null;
        setNowPlaying(file);
      }
      try {
        // Videos resume where they were left; songs start at the top unless resuming the last session.
        await openNativePlayer(file.id, fromStart || (music && !resume));
        if (request === generation.current) {
          setNowPlaying(file);
          setResumeAt(null);
          started.current?.();
        }
      } catch (cause) {
        if (request !== generation.current) return;
        if (isOpenCancelled(cause)) {
          // Replaced from the other window, or stopped there: follow what the player does now.
          lastBackendId.current = undefined;
          const playing = await getCurrentPlayerFile().catch(() => null);
          if (!playing && request === generation.current) setNowPlaying(null);
          return;
        }
        const message = errorText(cause);
        if (music) setError(message);
        else setNowPlaying(null);
        notify(`无法播放“${file.displayName}”：${message}`, "error");
      } finally {
        if (request === generation.current) setOpeningId(null);
      }
    },
    [notify],
  );

  // Remember the song and queue so the next launch can pick up where this one stopped.
  useEffect(() => {
    if (!nowPlaying || !isMusic(nowPlaying)) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ current: nowPlaying.id, queue: queue.slice(0, 1000).map((file) => file.id) }));
    } catch {
      // Session memory is best effort.
    }
  }, [nowPlaying, queue]);

  // Restore it once the library has loaded, paused, without starting playback.
  useEffect(() => {
    if (restoreAttempted.current || !loaded || !songs.length) return;
    restoreAttempted.current = true;
    if (latest.current.nowPlaying || readStatus().fileId) return;
    let session: { current?: string; queue?: string[] } | null = null;
    try {
      session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    } catch {
      return;
    }
    const byId = new Map(songs.map((file) => [file.id, file]));
    const file = session?.current ? byId.get(session.current) : undefined;
    if (!file) return;
    const restored = (session?.queue ?? []).flatMap((id) => byId.get(id) ?? []);
    setQueue(restored.some((item) => item.id === file.id) ? restored : [file]);
    setNowPlaying(file);
    const saved = recent.find((item) => item.fileId === file.id);
    setResumeAt({ position: saved?.position ?? 0, duration: saved?.duration ?? 0 });
  }, [loaded, recent, songs]);

  // Follow the backend: files started elsewhere, stops, and the end of a song.
  useEffect(() => {
    const offStatus = onStatus((status) => {
      previousVolume.current = unmuteVolume(previousVolume.current, status);
      const id = status.fileId ?? null;
      const { nowPlaying: current, queue: currentQueue, repeat: currentRepeat, openingId: opening } = latest.current;
      if (id !== lastBackendId.current) {
        lastBackendId.current = id;
        if (!id) {
          if (!opening) setNowPlaying(null);
        } else if (id !== current?.id && !opening) {
          void getCurrentPlayerFile()
            .then(async (file) => {
              if (!file || lastBackendId.current !== file.id) return;
              setError("");
              setNowPlaying(file);
              if (isMusic(file) && !latest.current.queue.some((item) => item.id === file.id)) {
                const playlist = await getPlayerPlaylist().catch(() => [] as MediaFile[]);
                const songs = playlist.filter((item) => item.mediaKind === "music");
                setQueue(songs.some((item) => item.id === file.id) ? songs : [file]);
                setShuffle(false);
              }
            })
            .catch(() => undefined);
        }
      }
      if (!current || !isMusic(current) || opening || status.duration <= 0 || id !== current.id) return;
      if (!status.eofReached) {
        if (handledEnd.current === current.id) handledEnd.current = null;
        return;
      }
      if (handledEnd.current === current.id) return;
      handledEnd.current = current.id;
      const index = currentQueue.findIndex((item) => item.id === current.id);
      const next = nextQueueIndex(index, currentQueue.length, currentRepeat, true);
      if (next !== null) void play(currentQueue[next], { fromStart: true, keepQueue: true });
    });
    const offStopped = onPlayerStopped(() => {
      if (!latest.current.openingId) setNowPlaying(null);
    });
    return () => {
      offStatus();
      offStopped();
    };
  }, [play]);

  // Videos switched from the video controls fail there, out of sight once the controls close.
  useEffect(() => onPlayerError(({ name, message }) => notify(`无法播放“${name}”：${message}`, "error")), [notify]);

  // Song details, lyrics and artwork; also feeds the system Now Playing widget.
  useEffect(() => {
    const file = nowPlaying;
    if (!file || !isMusic(file)) {
      metadataFor.current = null;
      setMetadata(null);
      setMetadataLoading(false);
      if (!file) setFullScreen(false);
      return;
    }
    if (metadataFor.current !== file.id) {
      metadataFor.current = file.id;
      setMetadata(null);
    }
    const refresh = refreshRequested.current;
    refreshRequested.current = false;
    let cancelled = false;
    const fallback = songParts(file);
    setMetadataLoading(true);
    getMusicMetadata(file.id, refresh)
      .then((value) => {
        if (cancelled) return;
        setMetadata(value);
        void setNowPlayingInfo({
          fileId: file.id,
          title: value.title || fallback.title,
          artist: value.artist || fallback.artist,
          album: value.album,
          artworkUrl: value.artworkUrl,
        }).catch(() => undefined);
      })
      .catch(() => {
        if (cancelled) return;
        setMetadata((previous) => previous ?? { title: fallback.title, artist: fallback.artist, album: "" });
        void setNowPlayingInfo({ fileId: file.id, title: fallback.title, artist: fallback.artist }).catch(() => undefined);
      })
      .finally(() => {
        if (!cancelled) setMetadataLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // The file identity, not the object, decides when to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowPlaying?.id, nowPlaying?.mediaKind, metadataRevision]);

  const api = useMemo<PlayerApi>(() => {
    const index = currentIndex;
    const openQueued = (file: MediaFile) => void play(file, { fromStart: true, keepQueue: true });
    return {
      nowPlaying,
      isVideo,
      openingId,
      queue,
      currentIndex: index,
      repeat,
      shuffle,
      metadata,
      metadataLoading,
      error,
      panel: fullScreen ? fullPanel : inspector,
      fullScreen,
      resumeAt,
      play,
      playShuffled(files) {
        if (!files.length) return;
        const first = files[Math.floor(Math.random() * files.length)];
        const ordered = [first, ...files.filter((file) => file.id !== first.id)];
        void play(first, { queue: shuffleUpcoming(ordered, 0), fromStart: true }).then(() => {
          originalOrder.current = files.map((file) => file.id);
          setShuffle(true);
        });
      },
      togglePlay() {
        if (!nowPlaying || openingId) return;
        const status = readStatus();
        if (status.fileId !== nowPlaying.id || status.eofReached) {
          const resume = !!resumeAt && status.fileId !== nowPlaying.id;
          void play(nowPlaying, { fromStart: !resume, resume, keepQueue: true });
        } else {
          command("play_pause");
        }
      },
      next() {
        if (!nowPlaying || openingId || index < 0) return;
        const target = nextQueueIndex(index, queue.length, repeat);
        if (target !== null) openQueued(queue[target]);
      },
      previous() {
        if (!nowPlaying || openingId) return;
        if (readStatus().position > 3 || index < 0) {
          command("seek_absolute", 0);
          return;
        }
        const target = index > 0 ? index - 1 : repeat === "all" ? queue.length - 1 : null;
        if (target === null) command("seek_absolute", 0);
        else openQueued(queue[target]);
      },
      seek: (seconds) => command("seek_absolute", seconds),
      setVolume: (volume) => command("volume", Math.round(volume)),
      changeVolume: (delta) => command("volume", Math.max(0, Math.min(100, Math.round(readStatus().volume + delta)))),
      toggleMute() {
        const volume = readStatus().volume;
        command("volume", volume > 0 ? 0 : previousVolume.current || 70);
      },
      stop() {
        generation.current++;
        setOpeningId(null);
        command("stop");
        setNowPlaying(null);
        setFullScreen(false);
        setResumeAt(null);
        try {
          localStorage.removeItem(SESSION_KEY);
        } catch {
          // Session memory is best effort.
        }
      },
      toggleShuffle() {
        if (queue.length < 2) return;
        if (!shuffle) {
          originalOrder.current = queue.map((file) => file.id);
          setQueue(shuffleUpcoming(queue, index));
        } else {
          const order = originalOrder.current;
          const rank = (file: MediaFile) => {
            const position = order.indexOf(file.id);
            return position < 0 ? Number.MAX_SAFE_INTEGER : position;
          };
          const upcoming = queue.slice(index + 1).sort((left, right) => rank(left) - rank(right));
          setQueue([...queue.slice(0, index + 1), ...upcoming]);
        }
        setShuffle(!shuffle);
      },
      cycleRepeat: () => setRepeat((value) => (value === "off" ? "all" : value === "all" ? "one" : "off")),
      moveInQueue(position, delta) {
        const target = position + delta;
        if (position <= index || target <= index || target >= queue.length) return;
        const nextQueue = [...queue];
        [nextQueue[position], nextQueue[target]] = [nextQueue[target], nextQueue[position]];
        setQueue(nextQueue);
      },
      removeFromQueue: (id) => setQueue((items) => items.filter((file) => file.id !== id || file.id === nowPlaying?.id)),
      playNext(files) {
        const list = Array.isArray(files) ? files : [files];
        if (!list.length) return;
        if (!nowPlaying || !isMusic(nowPlaying)) {
          void play(list[0], { queue: list, fromStart: true });
          return;
        }
        const moving = list.filter((file) => file.id !== nowPlaying.id);
        const ids = new Set(moving.map((file) => file.id));
        const rest = queue.filter((item) => !ids.has(item.id));
        const at = rest.findIndex((item) => item.id === nowPlaying.id);
        setQueue([...rest.slice(0, at + 1), ...moving, ...rest.slice(at + 1)]);
      },
      addToQueue(files) {
        const list = Array.isArray(files) ? files : [files];
        if (!list.length) return;
        if (!nowPlaying || !isMusic(nowPlaying)) {
          void play(list[0], { queue: list, fromStart: true });
          return;
        }
        const adding = list.filter((file) => file.id !== nowPlaying.id);
        const ids = new Set(adding.map((file) => file.id));
        setQueue((items) => [...items.filter((item) => !ids.has(item.id) || item.id === nowPlaying.id), ...adding]);
      },
      clearUpcoming: () => setQueue((items) => items.slice(0, Math.max(index + 1, 1))),
      refreshMetadata() {
        refreshRequested.current = true;
        setMetadataRevision((value) => value + 1);
      },
      togglePanel: (kind) => (fullScreen ? setFullPanel : setInspector)((value) => (value === kind ? null : kind)),
      setPanel: fullScreen ? setFullPanel : setInspector,
      setFullScreen,
    };
  }, [command, currentIndex, error, fullPanel, fullScreen, inspector, isVideo, metadata, metadataLoading, nowPlaying, openingId, play, queue, repeat, resumeAt, shuffle]);

  return <PlayerContext.Provider value={api}>{children}</PlayerContext.Provider>;
}
