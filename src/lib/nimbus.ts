import { previewAccounts, previewSources, previewFiles, previewMetadata, previewRecent, previewEntries } from "./preview";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

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
export type PlayerStatus = { fileId?: string | null; error?: string | null; running: boolean; paused: boolean; eofReached: boolean; position: number; duration: number; speed: number; volume: number; tracks: PlayerTrack[] };
export type MusicMetadata = { title: string; artist: string; album: string; artworkUrl?: string; lyrics?: string; syncedLyrics?: string };
export type MovieMetadata = { tmdbId: number; mediaType: "movie" | "tv"; title: string; originalTitle: string; year?: number; overview: string; rating: number; posterUrl?: string; genres: string[]; cast: string[] };

const isTauri = () => "__TAURI_INTERNALS__" in window;

const demoEnabled = !isTauri() && new URLSearchParams(window.location.search).get("demo") === "1";
const demoAccounts: Account[] = demoEnabled ? previewAccounts : [];

export async function getStatus(): Promise<AppStatus> {
  if (isTauri()) return invoke<AppStatus>("app_status");
  return { platform: "Browser preview", databaseReady: true, accountCount: demoAccounts.length, baiduConfigured: false, tmdbConfigured: false, mpvAvailable: false };
}

export async function listAccounts(): Promise<Account[]> {
  if (isTauri()) return invoke<Account[]>("account_list");
  return [...demoAccounts];
}

export async function removeAccount(accountId: string): Promise<void> {
  if (isTauri()) return invoke<void>("account_remove", { accountId });
  throw new Error("此操作只在 Cove macOS 应用中可用");
}

export async function addAccount(input: AccountInput): Promise<Account> {
  if (isTauri()) return invoke<Account>("account_add", { input });
  throw new Error("连接存储只在 Cove macOS 应用中可用");
}

export async function connectBaidu(label: string): Promise<Account> {
  if (isTauri()) return invoke<Account>("baidu_oauth_connect", { label });
  throw new Error("百度 OAuth 登录只在 Nimbus macOS 应用中可用");
}

export async function listMediaFiles(): Promise<MediaFile[]> {
  if (isTauri()) return invoke<MediaFile[]>("media_file_list");
  return demoEnabled ? previewFiles : [];
}

export async function browseAccount(accountId: string, path: string): Promise<CloudEntry[]> {
  if (isTauri()) return invoke<CloudEntry[]>("account_browse", { accountId, path });
  if (demoEnabled) return previewEntries(path);
  throw new Error("文件浏览只在 Cove macOS 应用中可用");
}

export async function copyEntry(sourceAccountId: string, sourcePath: string, sourceEntryId: string, sourceIsDir: boolean, destinationAccountId: string, destinationPath: string): Promise<void> {
  if (isTauri()) return invoke<void>("entry_copy", { sourceAccountId, sourcePath, sourceEntryId, sourceIsDir, destinationAccountId, destinationPath });
  throw new Error("此操作只在 Cove macOS 应用中可用");
}

export async function createFolder(accountId: string, parentPath: string, name: string): Promise<void> {
  if (isTauri()) return invoke<void>("folder_create", { accountId, parentPath, name });
  throw new Error("此操作只在 Cove macOS 应用中可用");
}

export async function listMediaSources(): Promise<MediaSource[]> {
  if (isTauri()) return invoke<MediaSource[]>("media_source_list");
  return demoEnabled ? previewSources : [];
}

export async function addMediaSource(accountId: string, kind: MediaSource["kind"], remoteRoot: string, label: string): Promise<MediaSource> {
  if (isTauri()) return invoke<MediaSource>("media_source_add", { accountId, kind, remoteRoot, label });
  throw new Error("媒体目录配置只在 Nimbus macOS 应用中可用");
}

export async function scanMediaSource(sourceId: string): Promise<ScanResult> {
  if (isTauri()) return invoke<ScanResult>("media_source_scan", { sourceId });
  throw new Error("扫描只在 Cove macOS 应用中可用");
}

export async function removeMediaSource(sourceId: string): Promise<void> {
  if (isTauri()) return invoke<void>("media_source_remove", { sourceId });
  throw new Error("此操作只在 Cove macOS 应用中可用");
}

export async function scanAccount(accountId: string): Promise<ScanResult> {
  if (isTauri()) return invoke<ScanResult>("account_scan", { accountId });
  throw new Error("扫描只在 Cove macOS 应用中可用");
}

export async function createStreamUrl(fileId: string): Promise<string> {
  if (isTauri()) return invoke<string>("player_stream_url", { fileId });
  throw new Error("播放代理只在 Nimbus macOS 应用中可用");
}

export async function openNativePlayer(fileId: string, fromStart = false): Promise<void> {
  if (isTauri()) return invoke<void>("player_open_native", { fileId, fromStart });
  throw new Error("原生播放器只在 Nimbus macOS 应用中可用");
}

export async function controlPlayer(action: string, value?: number): Promise<void> {
  if (isTauri()) return invoke<void>("player_control", { action, value });
}

export async function getPlayerStatus(): Promise<PlayerStatus> {
  if (isTauri()) return invoke<PlayerStatus>("player_status");
  return { running: false, paused: false, eofReached: false, position: 0, duration: 0, speed: 1, volume: 100, tracks: [] };
}

export async function getCurrentPlayerFile(): Promise<MediaFile | null> {
  if (isTauri()) return invoke<MediaFile | null>("player_current_file");
  return null;
}

export async function getMusicMetadata(fileId: string, refresh = false): Promise<MusicMetadata> {
  if (isTauri()) return invoke<MusicMetadata>("music_metadata", { fileId, refresh });
  return { title: "", artist: "", album: "" };
}

async function fetchMovieMetadata(fileId: string, refresh = false, lookupName?: string): Promise<MovieMetadata> {
  if (isTauri()) {
    const metadata = await invoke<MovieMetadata>("movie_metadata", { fileId, refresh, lookupName });
    return { ...metadata, genres: metadata.genres ?? [], cast: metadata.cast ?? [] };
  }
  if (demoEnabled && previewMetadata[fileId]) return previewMetadata[fileId];
  throw new Error("TMDB 刮削只在 Nimbus macOS 应用中可用");
}

const metadataRequests = new Map<string, { expires: number; value: Promise<MovieMetadata> }>();
let metadataActive = 0;
const metadataWaiters: (() => void)[] = [];
export function getMovieMetadata(fileId: string, refresh = false, lookupName?: string): Promise<MovieMetadata> {
  const key = `${fileId}:${lookupName ?? ""}`;
  const cached = metadataRequests.get(key);
  if (!refresh && cached && cached.expires > Date.now()) return cached.value;
  const value = (async () => {
    if (metadataActive >= 3) await new Promise<void>(resolve => metadataWaiters.push(resolve));
    metadataActive++;
    try { return await fetchMovieMetadata(fileId, refresh, lookupName); }
    finally { metadataActive--; metadataWaiters.shift()?.(); }
  })();
  const entry = { expires: Date.now() + 600_000, value };
  metadataRequests.set(key, entry);
  void value.catch(() => { entry.expires = Date.now() + 30_000; });
  return value;
}
export function subscribePlayer(callback: (status: PlayerStatus) => void) {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  if (isTauri()) {
    listen<PlayerStatus>("nimbus-player-state", event => { if (!disposed) callback(event.payload); })
      .then(off => { if (disposed) off(); else unlisten = off; }).catch(() => undefined);
    void getPlayerStatus().then(status => { if (!disposed) callback(status); }).catch(() => undefined);
  }
  return () => { disposed = true; unlisten?.(); };
}
export type RecentPlayback = { fileId: string; position: number; duration: number; updatedAt: number };
export async function listRecentPlayback(): Promise<RecentPlayback[]> { return isTauri() ? invoke("playback_recent") : demoEnabled ? previewRecent : []; }
export async function listCachedMovies(): Promise<Record<string, MovieMetadata>> { return isTauri() ? invoke("metadata_cached_movies") : demoEnabled ? previewMetadata : {}; }
export async function clearMetadataCache(): Promise<void> { metadataRequests.clear(); if (isTauri()) await invoke("metadata_cache_clear"); }

export async function playStorageFile(
  accountId: string,
  path: string,
  name: string,
  entryId?: string,
  siblings?: CloudEntry[]
): Promise<string> {
  if (isTauri())
    return invoke<string>("storage_play_file", {
      accountId,
      path,
      name,
      entryId: entryId ?? null,
      siblings: siblings ?? null,
    });
  throw new Error("只在 macOS 应用中可用");
}

export async function getPlayerPlaylist(): Promise<MediaFile[]> {
  if (isTauri()) return invoke<MediaFile[]>("player_playlist");
  return [];
}

export async function playerAddSubtitle(path: string, title?: string): Promise<void> {
  if (isTauri()) return invoke<void>("player_add_subtitle", { path, title: title ?? null });
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

export type SubtitleProgress = {
  fileId: string;
  stage: string;
  percent: number;
  message: string;
};

export type SubtitleResult = {
  fileId: string;
  srtPath: string;
  segmentCount: number;
  applied: boolean;
};

export async function generateAiSubtitles(fileId: string, config: AiSubtitleConfig): Promise<SubtitleResult> {
  if (isTauri()) return invoke<SubtitleResult>("ai_subtitles_generate", { fileId, config });
  throw new Error("只在 macOS 应用中可用");
}

export async function getCachedAiSubtitles(fileId: string): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("ai_subtitles_cached", { fileId });
  return null;
}

export async function openNativePath(path: string): Promise<void> {
  if (isTauri()) return invoke<void>("open_native_path", { path });
  throw new Error("此操作只在 Cove macOS 应用中可用");
}

export async function revealNativePath(path: string): Promise<void> {
  if (isTauri()) return invoke<void>("reveal_native_path", { path });
  throw new Error("此操作只在 Cove macOS 应用中可用");
}

export async function readTextPreview(path: string): Promise<string> {
  if (isTauri()) return invoke<string>("read_text_preview", { path });
  throw new Error("只在 macOS 应用中可用");
}


export async function loadAiKey(): Promise<string | null> { return isTauri() ? invoke("ai_key_load") : null; }
export async function saveAiKey(value: string): Promise<void> { if (isTauri()) return invoke("ai_key_save", {value}); throw new Error("密钥只在 macOS 钥匙串中保存"); }
