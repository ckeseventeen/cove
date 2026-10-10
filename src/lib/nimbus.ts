// Typed bridge to the Cove native backend. Outside the app, `?demo=1` serves fixture data.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./native";
import {
  previewAccounts,
  previewEntries,
  previewFiles,
  previewMetadata,
  previewMusicMetadata,
  previewRecent,
  previewSources,
} from "./preview";

export type Account = {
  id: string;
  provider: "local" | "webdav" | "google_drive" | "onedrive" | "baidu" | "alidrive" | "quark";
  label: string;
  endpoint: string;
  username?: string;
  status: string;
};

export type AccountInput = {
  provider: Account["provider"];
  label: string;
  endpoint: string;
  username: string;
  password: string;
};

export type AppStatus = {
  platform: string;
  databaseReady: boolean;
  accountCount: number;
  baiduConfigured: boolean;
  tmdbConfigured: boolean;
  mpvAvailable: boolean;
};

export type MediaFile = {
  id: string;
  accountId: string;
  remotePath: string;
  cloudPath?: string;
  displayName: string;
  size: number;
  etag?: string;
  mimeType?: string;
  sourceId?: string;
  sourceIds?: string[];
  mediaKind?: "movie" | "music";
};

export type CloudEntry = {
  id: string;
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  modifiedAt?: number | null;
};

export type MediaSource = {
  id: string;
  accountId: string;
  kind: "movie" | "music";
  remoteRoot: string;
  label: string;
  lastScanAt?: number;
};

export type ScanResult = {
  visitedDirectories: number;
  discoveredFiles: number;
  mediaFiles: number;
  truncated: boolean;
};

export type PlayerTrack = { id: number; kind: "audio" | "sub"; title: string; language: string; selected: boolean };
export type PlayerStatus = {
  fileId?: string | null;
  error?: string | null;
  running: boolean;
  paused: boolean;
  eofReached: boolean;
  position: number;
  duration: number;
  speed: number;
  volume: number;
  tracks: PlayerTrack[];
};
export type MusicMetadata = { title: string; artist: string; album: string; artworkUrl?: string; lyrics?: string; syncedLyrics?: string };
export type MovieMetadata = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle: string;
  year?: number;
  overview: string;
  rating: number;
  posterUrl?: string;
  genres: string[];
  cast: string[];
};
export type RecentPlayback = { fileId: string; position: number; duration: number; updatedAt: number };

const APP_ONLY = "此操作需要在 Cove macOS 应用中使用";
export const demoEnabled = !isTauri() && new URLSearchParams(window.location.search).get("demo") === "1";
const demoAccounts: Account[] = demoEnabled ? previewAccounts : [];

function appOnly(message = APP_ONLY): never {
  throw new Error(message);
}

export async function getStatus(): Promise<AppStatus> {
  if (isTauri()) return invoke<AppStatus>("app_status");
  return {
    platform: "浏览器预览",
    databaseReady: true,
    accountCount: demoAccounts.length,
    baiduConfigured: false,
    tmdbConfigured: false,
    mpvAvailable: false,
  };
}

export async function listAccounts(): Promise<Account[]> {
  if (isTauri()) return invoke<Account[]>("account_list");
  return [...demoAccounts];
}

export async function removeAccount(accountId: string): Promise<void> {
  if (isTauri()) return invoke<void>("account_remove", { accountId });
  appOnly();
}

export async function addAccount(input: AccountInput): Promise<Account> {
  if (isTauri()) return invoke<Account>("account_add", { input });
  appOnly("连接存储需要在 Cove macOS 应用中使用");
}

export async function connectBaidu(label: string): Promise<Account> {
  if (isTauri()) return invoke<Account>("baidu_oauth_connect", { label });
  appOnly("百度网盘授权需要在 Cove macOS 应用中使用");
}

export async function listMediaFiles(): Promise<MediaFile[]> {
  if (isTauri()) return invoke<MediaFile[]>("media_file_list");
  return demoEnabled ? previewFiles : [];
}

export async function browseAccount(accountId: string, path: string): Promise<CloudEntry[]> {
  if (isTauri()) return invoke<CloudEntry[]>("account_browse", { accountId, path });
  if (demoEnabled) return previewEntries(path);
  appOnly("浏览文件需要在 Cove macOS 应用中使用");
}

export async function copyEntry(
  sourceAccountId: string,
  sourcePath: string,
  sourceEntryId: string,
  sourceIsDir: boolean,
  destinationAccountId: string,
  destinationPath: string,
): Promise<void> {
  if (isTauri()) {
    return invoke<void>("entry_copy", {
      sourceAccountId,
      sourcePath,
      sourceEntryId,
      sourceIsDir,
      destinationAccountId,
      destinationPath,
    });
  }
  appOnly();
}

export async function createFolder(accountId: string, parentPath: string, name: string): Promise<void> {
  if (isTauri()) return invoke<void>("folder_create", { accountId, parentPath, name });
  appOnly();
}

export async function listMediaSources(): Promise<MediaSource[]> {
  if (isTauri()) return invoke<MediaSource[]>("media_source_list");
  return demoEnabled ? previewSources : [];
}

export async function addMediaSource(
  accountId: string,
  kind: MediaSource["kind"],
  remoteRoot: string,
  label: string,
): Promise<MediaSource> {
  if (isTauri()) return invoke<MediaSource>("media_source_add", { accountId, kind, remoteRoot, label });
  appOnly("添加媒体文件夹需要在 Cove macOS 应用中使用");
}

export async function scanMediaSource(sourceId: string): Promise<ScanResult> {
  if (isTauri()) return invoke<ScanResult>("media_source_scan", { sourceId });
  appOnly("扫描需要在 Cove macOS 应用中使用");
}

export async function removeMediaSource(sourceId: string): Promise<void> {
  if (isTauri()) return invoke<void>("media_source_remove", { sourceId });
  appOnly();
}

export async function openNativePlayer(fileId: string, fromStart = false): Promise<void> {
  if (isTauri()) return invoke<void>("player_open_native", { fileId, fromStart });
  const file = previewFiles.find((item) => item.id === fileId);
  if (demoEnabled && file?.mediaKind === "music") return demoPlayer.open(file);
  appOnly("视频播放需要在 Cove macOS 应用中使用");
}

export async function controlPlayer(action: string, value?: number): Promise<void> {
  if (isTauri()) return invoke<void>("player_control", { action, value });
  if (demoEnabled) demoPlayer.control(action, value);
}

export async function getPlayerStatus(): Promise<PlayerStatus> {
  if (isTauri()) return invoke<PlayerStatus>("player_status");
  return demoPlayer.snapshot();
}

export async function getCurrentPlayerFile(): Promise<MediaFile | null> {
  if (isTauri()) return invoke<MediaFile | null>("player_current_file");
  const id = demoPlayer.snapshot().fileId;
  return previewFiles.find((file) => file.id === id) ?? null;
}

export async function getPlayerPlaylist(): Promise<MediaFile[]> {
  if (isTauri()) return invoke<MediaFile[]>("player_playlist");
  return [];
}

export async function playerAddSubtitle(path: string, title?: string): Promise<void> {
  if (isTauri()) return invoke<void>("player_add_subtitle", { path, title: title ?? null });
}

/** Feed the system Now Playing widget (Control Center, media keys). */
export async function setNowPlayingInfo(info: {
  fileId: string;
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string | null;
}): Promise<void> {
  if (isTauri()) {
    return invoke<void>("now_playing_info", {
      info: { artist: "", album: "", ...info, artworkUrl: info.artworkUrl ?? null },
    });
  }
}

export function subscribePlayer(callback: (status: PlayerStatus) => void) {
  if (!isTauri()) return demoPlayer.subscribe(callback);
  let disposed = false;
  let unlisten: (() => void) | undefined;
  listen<PlayerStatus>("nimbus-player-state", (event) => {
    if (!disposed) callback(event.payload);
  })
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    })
    .catch(() => undefined);
  void getPlayerStatus()
    .then((status) => {
      if (!disposed) callback(status);
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export function onPlayerStopped(callback: () => void) {
  if (!isTauri()) return demoPlayer.onStopped(callback);
  let disposed = false;
  let unlisten: (() => void) | undefined;
  listen("nimbus-player-stopped", () => callback())
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export async function getMusicMetadata(fileId: string, refresh = false): Promise<MusicMetadata> {
  if (isTauri()) return invoke<MusicMetadata>("music_metadata", { fileId, refresh });
  const file = previewFiles.find((item) => item.id === fileId);
  if (demoEnabled && file) return previewMusicMetadata(file);
  return { title: "", artist: "", album: "" };
}

async function fetchMovieMetadata(fileId: string, refresh = false, lookupName?: string): Promise<MovieMetadata> {
  if (isTauri()) {
    const metadata = await invoke<MovieMetadata>("movie_metadata", { fileId, refresh, lookupName });
    return { ...metadata, genres: metadata.genres ?? [], cast: metadata.cast ?? [] };
  }
  if (demoEnabled && previewMetadata[fileId]) return previewMetadata[fileId];
  appOnly("影视资料匹配需要在 Cove macOS 应用中使用");
}

const metadataRequests = new Map<string, { expires: number; value: Promise<MovieMetadata> }>();
let metadataActive = 0;
const metadataWaiters: (() => void)[] = [];

/** Cached, concurrency-limited TMDB lookups shared by every poster in view. */
export function getMovieMetadata(fileId: string, refresh = false, lookupName?: string): Promise<MovieMetadata> {
  const key = `${fileId}:${lookupName ?? ""}`;
  const cached = metadataRequests.get(key);
  if (!refresh && cached && cached.expires > Date.now()) return cached.value;
  const value = (async () => {
    if (metadataActive >= 3) await new Promise<void>((resolve) => metadataWaiters.push(resolve));
    metadataActive++;
    try {
      return await fetchMovieMetadata(fileId, refresh, lookupName);
    } finally {
      metadataActive--;
      metadataWaiters.shift()?.();
    }
  })();
  const entry = { expires: Date.now() + 600_000, value };
  metadataRequests.set(key, entry);
  void value.catch(() => {
    entry.expires = Date.now() + 30_000;
  });
  return value;
}

export async function listRecentPlayback(): Promise<RecentPlayback[]> {
  if (isTauri()) return invoke<RecentPlayback[]>("playback_recent");
  return demoEnabled ? previewRecent : [];
}

export async function listCachedMovies(): Promise<Record<string, MovieMetadata>> {
  if (isTauri()) return invoke<Record<string, MovieMetadata>>("metadata_cached_movies");
  return demoEnabled ? previewMetadata : {};
}

export async function clearMetadataCache(): Promise<void> {
  metadataRequests.clear();
  if (isTauri()) await invoke("metadata_cache_clear");
}

export async function playStorageFile(
  accountId: string,
  path: string,
  name: string,
  entryId?: string,
  siblings?: CloudEntry[],
): Promise<string> {
  if (isTauri()) {
    return invoke<string>("storage_play_file", {
      accountId,
      path,
      name,
      entryId: entryId ?? null,
      siblings: siblings ?? null,
    });
  }
  appOnly("直接播放需要在 Cove macOS 应用中使用");
}

export type AiSubtitleConfig = {
  provider: "siliconflow" | "groq" | "openai" | "custom";
  apiKey: string;
  baseUrl?: string;
  model?: string;
  mode: "original" | "translate_zh" | "bilingual";
  scope: "full" | "preview";
  language?: string;
};

export type SubtitleProgress = { fileId: string; stage: string; percent: number; message: string };
export type SubtitleResult = { fileId: string; srtPath: string; segmentCount: number; applied: boolean };

export async function generateAiSubtitles(fileId: string, config: AiSubtitleConfig): Promise<SubtitleResult> {
  if (isTauri()) return invoke<SubtitleResult>("ai_subtitles_generate", { fileId, config });
  appOnly();
}

export async function getCachedAiSubtitles(fileId: string): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("ai_subtitles_cached", { fileId });
  return null;
}

export async function openNativePath(path: string): Promise<void> {
  if (isTauri()) return invoke<void>("open_native_path", { path });
  appOnly();
}

export async function revealNativePath(path: string): Promise<void> {
  if (isTauri()) return invoke<void>("reveal_native_path", { path });
  appOnly();
}

export async function readTextPreview(path: string): Promise<string> {
  if (isTauri()) return invoke<string>("read_text_preview", { path });
  appOnly("预览文件内容需要在 Cove macOS 应用中使用");
}

export async function loadAiKey(): Promise<string | null> {
  return isTauri() ? invoke<string | null>("ai_key_load") : null;
}

export async function saveAiKey(value: string): Promise<void> {
  if (isTauri()) return invoke("ai_key_save", { value });
  appOnly("密钥只保存在 macOS 钥匙串中");
}

/* ---------- Browser preview player: simulates libmpv for layout QA ---------- */

function createDemoPlayer() {
  const idle: PlayerStatus = {
    fileId: null,
    running: false,
    paused: false,
    eofReached: false,
    position: 0,
    duration: 0,
    speed: 1,
    volume: 70,
    tracks: [],
  };
  let status: PlayerStatus = { ...idle };
  let timer: number | undefined;
  const listeners = new Set<(status: PlayerStatus) => void>();
  const stopped = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener({ ...status }));
  const tick = () => {
    if (!status.fileId || status.paused || status.eofReached) return;
    status.position = Math.min(status.duration, status.position + 0.5 * status.speed);
    if (status.position >= status.duration) {
      status.eofReached = true;
      status.paused = true;
    }
    emit();
  };
  return {
    snapshot: () => ({ ...status }),
    open(file: MediaFile) {
      const seed = [...file.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
      status = {
        ...idle,
        fileId: file.id,
        running: true,
        duration: 150 + (seed % 90),
        volume: status.volume || idle.volume,
      };
      window.clearInterval(timer);
      timer = window.setInterval(tick, 500);
      emit();
    },
    control(action: string, value?: number) {
      if (!status.fileId) return;
      if (action === "stop") {
        window.clearInterval(timer);
        status = { ...idle, volume: status.volume };
        emit();
        stopped.forEach((callback) => callback());
        return;
      }
      if (action === "play_pause") status.paused = !status.paused;
      if (action === "play") status.paused = false;
      if (action === "pause") status.paused = true;
      if (action === "seek") status.position = Math.max(0, status.position + (value ?? 0));
      if (action === "seek_absolute") status.position = Math.max(0, value ?? 0);
      if (action === "volume") status.volume = Math.max(0, Math.min(100, value ?? 100));
      if (action === "speed") status.speed = value ?? 1;
      if (action.startsWith("seek")) {
        status.position = Math.min(status.position, status.duration);
        status.eofReached = status.position >= status.duration;
      }
      emit();
    },
    subscribe(listener: (status: PlayerStatus) => void) {
      listeners.add(listener);
      listener({ ...status });
      return () => {
        listeners.delete(listener);
      };
    },
    onStopped(callback: () => void) {
      stopped.add(callback);
      return () => {
        stopped.delete(callback);
      };
    },
  };
}

const demoPlayer = createDemoPlayer();
