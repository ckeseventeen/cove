// Typed bridge to the Cove native backend. Outside the app, `?demo=1` serves fixture data.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { lookupNameOf, type MediaWork } from "./media";
import { createMovieLookups, type MovieLookup } from "./movieLookup";
import { isTauri } from "./native";
import {
  previewAccounts,
  previewEntries,
  previewFiles,
  previewMetadata,
  previewMusicMetadata,
  previewPlaylists,
  previewReading,
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
  mediaKind?: "movie" | "music" | "document";
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
  kind: "movie" | "music" | "document";
  remoteRoot: string;
  label: string;
  lastScanAt?: number;
};

export type ScanResult = {
  visitedDirectories: number;
  discoveredFiles: number;
  mediaFiles: number;
  truncated: boolean;
  /** Subfolders that could not be read and were skipped; what the library had in them stays. */
  skippedDirectories: string[];
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
  /** The name it was looked up with; a work regrouped under another name needs a new lookup. */
  query?: string;
};
export type RecentPlayback = { fileId: string; position: number; duration: number; updatedAt: number };
export type ReadingProgress = {
  docKey: string;
  accountId: string;
  path: string;
  entryId: string;
  name: string;
  size: number;
  page: number;
  pageCount: number;
  updatedAt: number;
};

export type Playlist = { id: string; name: string; fileIds: string[]; updatedAt: number };

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

/** Sign in to Baidu in the browser; with `accountId`, renew that account's login in place. */
export async function connectBaidu(label: string, accountId?: string): Promise<Account> {
  if (isTauri()) return invoke<Account>("baidu_oauth_connect", { label, accountId: accountId ?? null });
  appOnly("百度网盘授权需要在 Cove macOS 应用中使用");
}

/** Stop a Baidu sign-in that is waiting for the browser. */
export async function cancelBaiduSignIn(): Promise<void> {
  if (isTauri()) return invoke<void>("baidu_oauth_cancel");
}

/** Save a new password or token for an account; its folders, progress and playlists stay. */
export async function updateAccountCredentials(accountId: string, username: string, password: string): Promise<Account> {
  if (isTauri()) return invoke<Account>("account_update_credentials", { accountId, username, password });
  appOnly("重新连接需要在 Cove macOS 应用中使用");
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
  if (demoEnabled && file) return demoPlayer.open(file);
  appOnly("视频播放需要在 Cove macOS 应用中使用");
}

/** An open replaced by a newer one, or by a stop, rejects with this (player.rs `OPEN_CANCELLED`); it is not a failure. */
export function isOpenCancelled(cause: unknown) {
  return (cause instanceof Error ? cause.message : String(cause)) === "已取消旧播放请求";
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

export type PlayerError = { fileId: string; name: string; message: string };

/** A file the video controls opened could not play; by then they are hidden, so the library window reports it. */
export function onPlayerError(callback: (error: PlayerError) => void) {
  if (!isTauri()) return () => undefined;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  listen<PlayerError>("nimbus-player-error", (event) => callback(event.payload))
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

async function fetchMovieMetadata({ fileIds, refresh, lookupName, series }: MovieLookup): Promise<MovieMetadata> {
  const [fileId] = fileIds;
  if (isTauri()) {
    const metadata = await invoke<MovieMetadata>("movie_metadata", { fileId, fileIds, refresh: !!refresh, lookupName, series });
    return { ...metadata, genres: metadata.genres ?? [], cast: metadata.cast ?? [] };
  }
  if (demoEnabled && previewMetadata[fileId]) return previewMetadata[fileId];
  appOnly("影视资料匹配需要在 Cove macOS 应用中使用");
}

const movieLookups = createMovieLookups(fetchMovieMetadata);

/**
 * A work's film or series details: cached, concurrency-limited TMDB lookups shared by every poster in
 * view, the detail sheet and the library's filters. `match` looks the work up under a name the user typed
 * (修正匹配), which the work keeps from then on; `background` prefetches behind what is on screen.
 */
export function getMovieMetadata(work: MediaWork, { match, background }: { match?: string; background?: boolean } = {}) {
  return movieLookups.lookup({
    fileIds: work.files.map((file) => file.id),
    lookupName: match ?? lookupNameOf(work),
    series: work.isSeries,
    refresh: match !== undefined,
    background,
  });
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
  movieLookups.clear();
  if (isTauri()) await invoke("metadata_cache_clear");
}

/** Interface size: one page zoom for both windows, set from 显示 › 放大 / 缩小 or Settings. */
export type UiZoom = { level: number; levels: number[] };

const demoZoom: UiZoom = { level: 1, levels: [1, 1.1, 1.2, 1.3, 1.4] };
const demoZoomListeners = new Set<(level: number) => void>();

export async function getUiZoom(): Promise<UiZoom> {
  if (isTauri()) return invoke<UiZoom>("ui_zoom_get");
  return { ...demoZoom };
}

export async function setUiZoom(level: number): Promise<UiZoom> {
  if (isTauri()) return invoke<UiZoom>("ui_zoom_set", { level });
  demoZoom.level = level;
  demoZoomListeners.forEach((listener) => listener(level));
  return { ...demoZoom };
}

export function onUiZoom(callback: (level: number) => void) {
  if (!isTauri()) {
    demoZoomListeners.add(callback);
    return () => void demoZoomListeners.delete(callback);
  }
  let disposed = false;
  let unlisten: (() => void) | undefined;
  listen<number>("ui-zoom", (event) => callback(event.payload))
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

/**
 * Follow the interface size in this window. The native app zooms the page itself; the page only
 * needs the level to keep the toolbar at its native height, centred on the window buttons.
 * ⇧⌘= ("⌘+") reaches the page because the menu's ⌘= does not match it.
 */
export function installUiZoom() {
  const root = document.documentElement;
  let current = demoZoom;
  const show = (level: number) => {
    current = { ...current, level };
    root.style.setProperty("--ui-zoom", String(level));
    // The browser preview has no page zoom; CSS zoom stands in for it.
    if (!isTauri()) root.style.setProperty("zoom", String(level));
  };
  void getUiZoom()
    .then((zoom) => {
      current = zoom;
      show(zoom.level);
    })
    .catch(() => undefined);
  onUiZoom(show);
  window.addEventListener("keydown", (event) => {
    if (!event.metaKey || event.ctrlKey || event.altKey) return;
    // "⌘+" is ⇧⌘= on the keyboard: match the character and, to be safe, the physical key.
    const plus = event.key === "+" || (event.shiftKey && event.code === "Equal");
    const keys: Record<string, number> = { "=": 1, "-": -1, "0": 0 };
    const direction = plus ? 1 : isTauri() ? undefined : keys[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    const index = current.levels.indexOf(current.level);
    const next = direction === 0 ? 1 : current.levels[Math.min(Math.max(index + direction, 0), current.levels.length - 1)];
    if (next !== undefined && next !== current.level) void setUiZoom(next).catch(() => undefined);
  });
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

/* ---------- Documents: PDFs open in the native PDFKit reader, which remembers the page ---------- */

export async function openDocument(accountId: string, path: string, name: string, entryId?: string, size?: number): Promise<ReadingProgress> {
  if (isTauri()) return invoke<ReadingProgress>("document_open", { accountId, path, name, entryId: entryId ?? null, size: size ?? null });
  appOnly("阅读 PDF 需要在 Cove macOS 应用中使用");
}

export async function openDocumentFile(fileId: string): Promise<ReadingProgress> {
  if (isTauri()) return invoke<ReadingProgress>("document_open_file", { fileId });
  appOnly("阅读 PDF 需要在 Cove macOS 应用中使用");
}

export async function listReadingProgress(): Promise<ReadingProgress[]> {
  if (isTauri()) return invoke<ReadingProgress[]>("document_progress_list");
  return demoEnabled ? previewReading : [];
}

export function onReadingProgress(callback: (progress: ReadingProgress) => void) {
  if (!isTauri()) return () => undefined;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  listen<ReadingProgress>("reading-progress", (event) => callback(event.payload))
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

/* ---------- Playlists: ordered lists of library songs, kept in the library database ---------- */

// The browser preview keeps playlists in memory so the layout can be exercised without the app.
let previewPlaylistStore: Playlist[] = demoEnabled ? previewPlaylists.map((playlist) => ({ ...playlist, fileIds: [...playlist.fileIds] })) : [];
const now = () => Math.floor(Date.now() / 1000);

export async function listPlaylists(): Promise<Playlist[]> {
  if (isTauri()) return invoke<Playlist[]>("playlist_list");
  return previewPlaylistStore.map((playlist) => ({ ...playlist, fileIds: [...playlist.fileIds] }));
}

export async function createPlaylist(name: string, fileIds: string[] = []): Promise<Playlist> {
  if (isTauri()) return invoke<Playlist>("playlist_create", { name, fileIds });
  const playlist = { id: `playlist-${Date.now()}`, name: name.trim(), fileIds: [...new Set(fileIds)], updatedAt: now() };
  previewPlaylistStore = [...previewPlaylistStore, playlist];
  return { ...playlist, fileIds: [...playlist.fileIds] };
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
  if (isTauri()) return invoke("playlist_rename", { id, name });
  previewPlaylistStore = previewPlaylistStore.map((playlist) => (playlist.id === id ? { ...playlist, name: name.trim(), updatedAt: now() } : playlist));
}

export async function deletePlaylist(id: string): Promise<void> {
  if (isTauri()) return invoke("playlist_delete", { id });
  previewPlaylistStore = previewPlaylistStore.filter((playlist) => playlist.id !== id);
}

export async function setPlaylistItems(id: string, fileIds: string[]): Promise<void> {
  if (isTauri()) return invoke("playlist_set_items", { id, fileIds });
  previewPlaylistStore = previewPlaylistStore.map((playlist) => (playlist.id === id ? { ...playlist, fileIds: [...fileIds], updatedAt: now() } : playlist));
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
