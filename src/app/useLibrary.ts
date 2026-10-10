import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildMovieWorks, type MediaWork } from "../lib/media";
import {
  getStatus,
  listAccounts,
  listCachedMovies,
  listMediaFiles,
  listMediaSources,
  listRecentPlayback,
  removeAccount as removeAccountCommand,
  removeMediaSource,
  scanMediaSource,
  type Account,
  type AppStatus,
  type MediaFile,
  type MediaSource,
  type MovieMetadata,
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
  const [movieMetadata, setMovieMetadataMap] = useState<Record<string, MovieMetadata>>({});
  const [loaded, setLoaded] = useState(false);
  const [scanningIds, setScanningIds] = useState<ReadonlySet<string>>(new Set());
  const scanning = useRef(new Set<string>());

  const works = useMemo(() => buildMovieWorks(files.filter((file) => file.mediaKind === "movie")), [files]);
  const songs = useMemo(() => files.filter((file) => file.mediaKind === "music"), [files]);
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

  useEffect(() => {
    Promise.all([getStatus(), listAccounts(), listMediaSources(), listMediaFiles(), listRecentPlayback(), listCachedMovies()])
      .then(([nextStatus, nextAccounts, nextSources, nextFiles, nextRecent, cached]) => {
        const initial: Record<string, MovieMetadata> = {};
        for (const work of buildMovieWorks(nextFiles.filter((file) => file.mediaKind === "movie"))) {
          const metadata = cached[work.files[0].id];
          if (metadata) initial[work.id] = { ...metadata, genres: metadata.genres ?? [], cast: metadata.cast ?? [] };
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

  return {
    loaded,
    accounts,
    sources,
    files,
    status,
    recent,
    works,
    songs,
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
