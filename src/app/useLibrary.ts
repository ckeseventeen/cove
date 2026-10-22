import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildCourses } from "../lib/courses";
import { buildMovieWorks, lookupKeyOf, type MediaWork, type SongInfo } from "../lib/media";
import { appendUnique, untitledName } from "../lib/playlists";
import {
  createPlaylist as createPlaylistCommand,
  deletePlaylist as deletePlaylistCommand,
  getStatus,
  listAccounts,
  listCachedMovies,
  listMediaFiles,
  listMediaSources,
  listPlaylists,
  listReadingProgress,
  listRecentPlayback,
  listCachedMusic,
  listSmartLists,
  listOffline,
  onOfflineProgress,
  downloadOffline,
  cancelOffline,
  removeOffline,
  type OfflineProgress,
  type SmartLists,
  getMusicMetadata,
  markWatched as markWatchedCommand,
  onPlayerStopped,
  onReadingProgress,
  onSourceScan,
  removeAccount as removeAccountCommand,
  removeMediaSource,
  renamePlaylist as renamePlaylistCommand,
  scanMediaSource,
  setPlaylistItems,
  type Account,
  type AppStatus,
  type MediaFile,
  type MediaSource,
  type MovieMetadata,
  type Playlist,
  type ReadingProgress,
  type RecentPlayback,
} from "../lib/nimbus";
import { onStatus } from "../player/statusStore";
import type { Notify } from "../ui/Toasts";
import { backgroundScanSummary, scanSummary } from "../lib/scan";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Everything the library windows show, loaded once and derived in one place. */
export function useLibrary(notify: Notify) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sources, setSources] = useState<MediaSource[]>([]);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [recent, setRecent] = useState<RecentPlayback[]>([]);
  const [reading, setReading] = useState<ReadingProgress[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const playlistsRef = useRef(playlists);
  playlistsRef.current = playlists;
  const [movieMetadata, setMovieMetadataMap] = useState<Record<string, MovieMetadata>>({});
  const [loaded, setLoaded] = useState(false);
  const [scanningIds, setScanningIds] = useState<ReadonlySet<string>>(new Set());
  const scanning = useRef(new Set<string>());

  const works = useMemo(() => buildMovieWorks(files.filter((file) => file.mediaKind === "movie")), [files]);
  const songs = useMemo(() => files.filter((file) => file.mediaKind === "music"), [files]);
  // PDFs from course folders are reading too: papers, textbooks and handouts appear in 文档.
  const documents = useMemo(
    () => files.filter((file) => file.mediaKind === "document" || (file.mediaKind === "course" && /\.pdf$/i.test(file.displayName))),
    [files],
  );
  const courses = useMemo(() => buildCourses(files.filter((file) => file.mediaKind === "course"), sources), [files, sources]);
  const courseCount = useMemo(() => courses.filter((course) => course.lessons.length > 0).length, [courses]);
  const readingByKey = useMemo(() => new Map(reading.map((item) => [item.docKey, item])), [reading]);
  const filesById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);
  const savedById = useMemo(() => new Map(recent.map((item) => [item.fileId, item])), [recent]);
  const workByFileId = useMemo(() => {
    const map = new Map<string, MediaWork>();
    for (const work of works) for (const file of work.files) map.set(file.id, work);
    return map;
  }, [works]);

  const refresh = useCallback(async () => {
    const [nextStatus, nextAccounts, nextSources, nextFiles, nextRecent] = await Promise.all([
      getStatus(),
      listAccounts(),
      listMediaSources(),
      listMediaFiles(),
      listRecentPlayback(),
    ]);
    setStatus(nextStatus);
    setAccounts(nextAccounts);
    setSources(nextSources);
    setFiles(nextFiles);
    setRecent(nextRecent);
  }, []);

  const refreshRecent = useCallback(() => {
    void listRecentPlayback()
      .then(setRecent)
      .catch(() => undefined);
  }, []);

  // The player saves the position when it stops (also on closing the window) or moves on to another
  // file, then reports the change: reload the saved positions so 继续播放 follows what was watched.
  useEffect(() => {
    let playing: string | null | undefined;
    const offStatus = onStatus(({ fileId }) => {
      const id = fileId ?? null;
      if (playing !== undefined && id !== playing) refreshRecent();
      playing = id;
    });
    const offStopped = onPlayerStopped(refreshRecent);
    return () => {
      offStatus();
      offStopped();
    };
  }, [refreshRecent]);

  // The reader reports page changes; keep the newest entry first.
  useEffect(
    () =>
      onReadingProgress((progress) =>
        setReading((current) => [progress, ...current.filter((item) => item.docKey !== progress.docKey)]),
      ),
    [],
  );

  useEffect(() => {
    void listReadingProgress()
      .then(setReading)
      .catch(() => undefined);
    void listPlaylists()
      .then(setPlaylists)
      .catch(() => undefined);
    Promise.all([getStatus(), listAccounts(), listMediaSources(), listMediaFiles(), listRecentPlayback(), listCachedMovies()])
      .then(([nextStatus, nextAccounts, nextSources, nextFiles, nextRecent, cached]) => {
        const initial: Record<string, MovieMetadata> = {};
        for (const work of buildMovieWorks(nextFiles.filter((file) => file.mediaKind === "movie"))) {
          const metadata = cached[work.files[0].id];
          if (metadata && (!metadata.query || metadata.query === lookupKeyOf(work))) {
            initial[work.id] = { ...metadata, genres: metadata.genres ?? [], cast: metadata.cast ?? [] };
          }
        }
        setMovieMetadataMap(initial);
        setStatus(nextStatus);
        setAccounts(nextAccounts);
        setSources(nextSources);
        setFiles(nextFiles);
        setRecent(nextRecent);
      })
      .catch((cause) => notify(`资料库载入失败：${errorText(cause)}`, "error"))
      .finally(() => setLoaded(true));
  }, [notify]);

  const setMovieMetadata = useCallback((workId: string, metadata: MovieMetadata) => {
    setMovieMetadataMap((current) => (current[workId] === metadata ? current : { ...current, [workId]: metadata }));
  }, []);

  const clearMovieMetadata = useCallback(() => setMovieMetadataMap({}), []);

  // Song details for the 艺人 and 专辑 views: what was looked up before, and a lookup of the rest on request.
  const [songInfo, setSongInfo] = useState<ReadonlyMap<string, SongInfo>>(new Map());
  // Videos downloaded (or downloading) for offline viewing, by file.
  const [offline, setOffline] = useState<ReadonlyMap<string, OfflineProgress>>(new Map());
  const filesByIdRef = useRef(filesById);
  filesByIdRef.current = filesById;
  useEffect(() => {

    // One toast when the queue empties, not one per episode of a season.
    const finished: string[] = [];
    const states = new Map<string, OfflineProgress>();
    void listOffline()
      .then((items) => {
        items.forEach((item) => states.set(item.fileId, item));
        setOffline(new Map(states));
      })
      .catch(() => undefined);
    return onOfflineProgress((progress) => {
      if (progress.state === "cancelled") states.delete(progress.fileId);
      else states.set(progress.fileId, progress);
      setOffline(new Map(states));
      const name = (id: string) => filesByIdRef.current.get(id)?.displayName ?? "视频";
      if (progress.state === "failed") notify(`无法下载“${name(progress.fileId)}”：${progress.message ?? "未知错误"}`, "error");
      if (progress.state !== "done") return;
      finished.push(progress.fileId);
      if ([...states.values()].some((item) => item.state === "queued" || item.state === "downloading")) return;
      notify(finished.length === 1 ? `已下载“${name(finished[0])}”，可以离线观看` : `已下载 ${finished.length} 个视频，可以离线观看`, "success");
      finished.length = 0;
    });
  }, [notify]);
  const download = useCallback(
    async (fileIds: string[]) => {
      try {
        const queued = await downloadOffline(fileIds);
        if (!queued) notify("这些视频已下载，或存储在这台 Mac 上，无需下载", "info");
      } catch (cause) {
        notify(`无法开始下载：${errorText(cause)}`, "error");
      }
    },
    [notify],
  );
  const cancelDownload = useCallback((fileIds: string[]) => void cancelOffline(fileIds).catch(() => undefined), []);
  const removeDownload = useCallback((fileIds: string[]) => void removeOffline(fileIds).catch(() => undefined), []);

  // 最近添加 / 最常播放 / 最近播放, refreshed when a song starts or a folder changes.
  const [smartLists, setSmartLists] = useState<SmartLists>({ recentlyAdded: [], mostPlayed: [], recentlyPlayed: [] });
  const refreshSmartLists = useCallback(() => {
    void listSmartLists()
      .then(setSmartLists)
      .catch(() => undefined);
  }, []);
  useEffect(refreshSmartLists, [refreshSmartLists]);
  const [albumLookup, setAlbumLookup] = useState<{ done: number; total: number } | null>(null);
  const lookupStopped = useRef(false);
  useEffect(() => {
    void listCachedMusic()
      .then((cached) => setSongInfo(new Map(Object.entries(cached))))
      .catch(() => undefined);
  }, []);

  const lookUpAlbums = useCallback(async () => {
    if (albumLookup) return;
    const pending = songs.filter((song) => !songInfo.get(song.id)?.album);
    if (!pending.length) return;
    lookupStopped.current = false;
    let done = 0;
    let found = 0;
    setAlbumLookup({ done, total: pending.length });
    const queue = [...pending];
    // Two at a time keeps the lookup services (and the network) comfortable.
    const worker = async () => {
      while (queue.length && !lookupStopped.current) {
        const song = queue.shift()!;
        try {
          const metadata = await getMusicMetadata(song.id);
          if (metadata.album) found++;
          setSongInfo((current) =>
            new Map(current).set(song.id, { title: metadata.title, artist: metadata.artist, album: metadata.album, artworkUrl: metadata.artworkUrl }),
          );
        } catch {
          // A song the services do not know stays without an album.
        }
        setAlbumLookup({ done: ++done, total: pending.length });
      }
    };
    await Promise.all([worker(), worker()]);
    setAlbumLookup(null);
    notify(
      lookupStopped.current ? `已停止获取专辑信息，找到 ${found} 首歌曲的专辑` : `专辑信息已更新：${found} / ${pending.length} 首歌曲找到了专辑`,
      "info",
    );
  }, [albumLookup, notify, songInfo, songs]);

  const stopAlbumLookup = useCallback(() => {
    lookupStopped.current = true;
  }, []);

  /** 标记为已看过 / 未看过 for whole works or single episodes, in play order. */
  const markWatched = useCallback(
    async (fileIds: string[], watched: boolean) => {
      try {
        await markWatchedCommand(fileIds, watched);
        setRecent(await listRecentPlayback());
      } catch (cause) {
        notify(`无法更新观看记录：${errorText(cause)}`, "error");
      }
    },
    [notify],
  );

  // Folders also update by themselves (auto_scan.rs): follow every scan, and refresh after a background one.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  useEffect(
    () =>
      onSourceScan((event) => {
        if (event.phase === "started") scanning.current.add(event.sourceId);
        else scanning.current.delete(event.sourceId);
        setScanningIds(new Set(scanning.current));
        // A manual scan reports and refreshes itself.
        if (!event.background || event.phase !== "finished") return;
        void refresh().catch(() => undefined);
        if (event.added) refreshSmartLists();
        const source = sourcesRef.current.find((item) => item.id === event.sourceId);
        const message = source && backgroundScanSummary(source.label, source.kind, event.added);
        if (message) notify(message, "info");
      }),
    [notify, refresh, refreshSmartLists],
  );

  /** A song or video started: 继续播放 and the play-based lists move. */
  const playbackStarted = useCallback(() => {
    refreshRecent();
    refreshSmartLists();
  }, [refreshRecent, refreshSmartLists]);

  const scanSource = useCallback(
    async (source: MediaSource) => {
      if (scanning.current.has(source.id)) return;
      scanning.current.add(source.id);
      setScanningIds(new Set(scanning.current));
      try {
        const result = await scanMediaSource(source.id);
        await refresh();
        const summary = scanSummary(source.label, source.kind, result);
        notify(summary.message, summary.tone);
      } catch (cause) {
        notify(`无法扫描“${source.label}”：${errorText(cause)}`, "error");
      } finally {
        scanning.current.delete(source.id);
        setScanningIds(new Set(scanning.current));
      }
    },
    [notify, refresh],
  );

  const addSource = useCallback(
    (source: MediaSource) => {
      setSources((current) => [...current.filter((item) => item.id !== source.id), source]);
      void scanSource(source);
    },
    [scanSource],
  );

  const removeSource = useCallback(
    async (source: MediaSource) => {
      try {
        await removeMediaSource(source.id);
        await refresh();
        notify(`已移除“${source.label}”。存储中的文件没有改动。`, "success");
        return true;
      } catch (cause) {
        notify(`无法移除“${source.label}”：${errorText(cause)}`, "error");
        return false;
      }
    },
    [notify, refresh],
  );

  const addAccount = useCallback((account: Account) => {
    setAccounts((current) => [...current.filter((item) => item.id !== account.id), account]);
  }, []);

  const removeAccount = useCallback(
    async (account: Account) => {
      try {
        await removeAccountCommand(account.id);
        setAccounts((current) => current.filter((item) => item.id !== account.id));
        setSources((current) => current.filter((source) => source.accountId !== account.id));
        setFiles((current) => current.filter((file) => file.accountId !== account.id));
        setReading((current) => current.filter((item) => item.accountId !== account.id));
        notify(`已移除“${account.label}”。存储中的文件没有改动。`, "success");
        return true;
      } catch (cause) {
        notify(`无法移除“${account.label}”：${errorText(cause)}`, "error");
        return false;
      }
    },
    [notify],
  );

  /* Playlists update the window immediately and roll back if the library refuses the change. */
  const changePlaylists = useCallback(
    async (next: Playlist[], save: () => Promise<unknown>, failure: string) => {
      const previous = playlistsRef.current;
      playlistsRef.current = next;
      setPlaylists(next);
      try {
        await save();
        return true;
      } catch (cause) {
        playlistsRef.current = previous;
        setPlaylists(previous);
        notify(`${failure}：${errorText(cause)}`, "error");
        return false;
      }
    },
    [notify],
  );

  const createPlaylist = useCallback(
    async (songs: MediaFile[] = [], name?: string) => {
      try {
        const created = await createPlaylistCommand(
          name ?? untitledName(playlistsRef.current.map((item) => item.name)),
          songs.map((file) => file.id),
        );
        playlistsRef.current = [...playlistsRef.current, created];
        setPlaylists(playlistsRef.current);
        return created;
      } catch (cause) {
        notify(`无法新建播放列表：${errorText(cause)}`, "error");
        return null;
      }
    },
    [notify],
  );

  const renamePlaylist = useCallback(
    (playlist: Playlist, name: string) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed === playlist.name) return Promise.resolve(true);
      return changePlaylists(
        playlistsRef.current.map((item) => (item.id === playlist.id ? { ...item, name: trimmed } : item)),
        () => renamePlaylistCommand(playlist.id, trimmed),
        "无法重命名播放列表",
      );
    },
    [changePlaylists],
  );

  const deletePlaylist = useCallback(
    (playlist: Playlist) =>
      changePlaylists(
        playlistsRef.current.filter((item) => item.id !== playlist.id),
        () => deletePlaylistCommand(playlist.id),
        `无法删除“${playlist.name}”`,
      ),
    [changePlaylists],
  );

  /** Replace a playlist's order (after a drag or a removal). */
  const setPlaylistOrder = useCallback(
    (playlist: Playlist, fileIds: string[]) =>
      changePlaylists(
        playlistsRef.current.map((item) => (item.id === playlist.id ? { ...item, fileIds } : item)),
        () => setPlaylistItems(playlist.id, fileIds),
        `无法更新“${playlist.name}”`,
      ),
    [changePlaylists],
  );

  const addToPlaylist = useCallback(
    async (playlist: Playlist, songs: MediaFile[]) => {
      const latest = playlistsRef.current.find((item) => item.id === playlist.id) ?? playlist;
      const { order, added } = appendUnique(
        latest.fileIds,
        songs.map((file) => file.id),
      );
      if (!added) {
        notify(songs.length === 1 ? `这首歌曲已在“${latest.name}”中` : `这些歌曲已在“${latest.name}”中`, "info");
        return;
      }
      if (await setPlaylistOrder(latest, order)) {
        notify(added === 1 ? `已添加到“${latest.name}”` : `已将 ${added} 首歌曲添加到“${latest.name}”`, "success");
      }
    },
    [notify, setPlaylistOrder],
  );

  return {
    loaded,
    accounts,
    sources,
    files,
    status,
    recent,
    works,
    songs,
    documents,
    courses,
    courseCount,
    reading,
    readingByKey,
    savedById,
    markWatched,
    songInfo,
    smartLists,
    playbackStarted,
    offline,
    download,
    cancelDownload,
    removeDownload,
    albumLookup,
    lookUpAlbums,
    stopAlbumLookup,
    playlists,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    setPlaylistOrder,
    addToPlaylist,
    filesById,
    workByFileId,
    movieMetadata,
    scanningIds,
    refresh,
    refreshRecent,
    setMovieMetadata,
    clearMovieMetadata,
    scanSource,
    addSource,
    removeSource,
    addAccount,
    removeAccount,
  };
}

export type Library = ReturnType<typeof useLibrary>;
