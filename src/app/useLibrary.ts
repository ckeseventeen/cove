import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildMovieWorks, lookupNameOf, type MediaWork } from "../lib/media";
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
  onReadingProgress,
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
import type { Notify } from "../ui/Toasts";

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
  const documents = useMemo(() => files.filter((file) => file.mediaKind === "document"), [files]);
  const readingByKey = useMemo(() => new Map(reading.map((item) => [item.docKey, item])), [reading]);
  const filesById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);
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
          if (metadata && (!metadata.query || metadata.query === lookupNameOf(work))) {
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

  const scanSource = useCallback(
    async (source: MediaSource) => {
      if (scanning.current.has(source.id)) return;
      scanning.current.add(source.id);
      setScanningIds(new Set(scanning.current));
      try {
        const result = await scanMediaSource(source.id);
        await refresh();
        const unit = source.kind === "music" ? "首歌曲" : "个视频";
        notify(
          result.truncated
            ? `“${source.label}”只扫描了一部分，已保留原有索引。可以选择更小的文件夹后重试。`
            : `“${source.label}”已更新，共 ${result.mediaFiles} ${unit}`,
          result.truncated ? "info" : "success",
        );
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
    reading,
    readingByKey,
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
