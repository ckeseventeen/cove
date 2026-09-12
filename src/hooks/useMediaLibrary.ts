import { useEffect, useMemo, useState } from "react";
import {
  buildMovieWorks,
  categoryOf,
  musicFolderOf,
  musicSourceOf,
  musicTitleOf,
  type MediaWork,
} from "../lib/media";
import {
  getStatus,
  listAccounts,
  listCachedMovies,
  listMediaFiles,
  listMediaSources,
  listRecentPlayback,
  type Account,
  type AppStatus,
  type MediaFile,
  type MediaSource,
  type MovieMetadata,
  type RecentPlayback,
} from "../lib/nimbus";
import type { MovieCategory, MovieSort } from "../views/MovieView";
import type { MusicSort } from "../views/MusicView";

export function useMediaLibrary() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sources, setSources] = useState<MediaSource[]>([]);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [recent, setRecent] = useState<RecentPlayback[]>([]);
  const [movieMetadata, setMovieMetadata] = useState<Record<string, MovieMetadata>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  async function reloadFiles() {
    setFiles(await listMediaFiles());
  }

  async function refreshAll() {
    const [nextStatus, nextAccounts, nextSources, nextFiles] = await Promise.all([
      getStatus(),
      listAccounts(),
      listMediaSources(),
      listMediaFiles(),
    ]);
    setStatus(nextStatus);
    setAccounts(nextAccounts);
    setSources(nextSources);
    setFiles(nextFiles);
  }

  // Initial load
  useEffect(() => {
    Promise.all([
      getStatus(),
      listAccounts(),
      listMediaFiles(),
      listMediaSources(),
      listRecentPlayback(),
      listCachedMovies(),
    ])
      .then(([nextStatus, nextAccounts, nextFiles, nextSources, nextRecent, cached]) => {
        setRecent(nextRecent);
        setMovieMetadata(
          Object.fromEntries(
            buildMovieWorks(nextFiles.filter((f) => f.mediaKind === "movie")).flatMap((work) =>
              cached[work.files[0].id] ? [[work.id, cached[work.files[0].id]]] : []
            )
          )
        );
        setStatus(nextStatus);
        setAccounts(nextAccounts);
        setFiles(nextFiles);
        setSources(nextSources);
      })
      .catch((error) => setLoadError(`加载失败：${String(error)}，请重新打开应用重试`));
  }, []);

  return {
    accounts, setAccounts,
    sources, setSources,
    files, setFiles,
    status,
    recent, setRecent,
    movieMetadata, setMovieMetadata,
    loadError,
    reloadFiles,
    refreshAll,
  };
}

export function useMovieShelves(
  files: MediaFile[],
  movieMetadata: Record<string, MovieMetadata>,
  sourceFilter: string | null,
  query: string,
  movieCategory: MovieCategory,
  movieYear: string,
  movieSort: MovieSort
) {
  const scopedFiles = useMemo(
    () =>
      sourceFilter
        ? files.filter(
            (file) => file.sourceIds?.includes(sourceFilter) || file.sourceId === sourceFilter
          )
        : files,
    [files, sourceFilter]
  );

  const allMovieWorks = useMemo(
    () => buildMovieWorks(scopedFiles.filter((file) => file.mediaKind === "movie")),
    [scopedFiles]
  );

  const totalMovieCount = useMemo(
    () => buildMovieWorks(files.filter((file) => file.mediaKind === "movie")).length,
    [files]
  );

  const movieYears = useMemo(
    () =>
      [
        ...new Set(
          Object.values(movieMetadata).flatMap((metadata) => (metadata.year ? [metadata.year] : []))
        ),
      ].sort((a, b) => b - a),
    [movieMetadata]
  );

  const movieShelves = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return allMovieWorks
      .filter((work) => {
        const metadata = movieMetadata[work.id];
        const searchable = [
          work.title,
          metadata?.title,
          metadata?.originalTitle,
          ...(metadata?.cast ?? []),
          ...work.files.map((file) => file.displayName),
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase();
        return (
          (!needle || searchable.includes(needle)) &&
          (movieCategory === "all" || categoryOf(work, metadata) === movieCategory) &&
          (movieYear === "all" || metadata?.year === Number(movieYear))
        );
      })
      .sort((a, b) => {
        const left = movieMetadata[a.id];
        const right = movieMetadata[b.id];
        if (movieSort === "oldest") return (left?.year ?? 9999) - (right?.year ?? 9999);
        if (movieSort === "rating") return (right?.rating ?? -1) - (left?.rating ?? -1);
        if (movieSort === "title") {
          return (left?.title ?? a.title).localeCompare(right?.title ?? b.title, "zh-CN");
        }
        return (right?.year ?? 0) - (left?.year ?? 0);
      });
  }, [allMovieWorks, movieCategory, movieMetadata, movieSort, movieYear, query]);

  return { allMovieWorks, totalMovieCount, movieYears, movieShelves, scopedFiles };
}

export function useMusicFiles(
  scopedFiles: MediaFile[],
  musicSort: MusicSort,
  sources: MediaSource[],
  accounts: Account[],
  query: string
) {
  const musicFiles = useMemo(() => {
    return scopedFiles
      .filter((file) => file.mediaKind === "music")
      .sort((left, right) => {
        if (musicSort === "title-desc") {
          return musicTitleOf(right).localeCompare(musicTitleOf(left), "zh-CN", { numeric: true });
        }
        if (musicSort === "folder") {
          return (
            musicFolderOf(left).localeCompare(musicFolderOf(right), "zh-CN", { numeric: true }) ||
            musicTitleOf(left).localeCompare(musicTitleOf(right), "zh-CN", { numeric: true })
          );
        }
        if (musicSort === "source") {
          return (
            musicSourceOf(left, sources, accounts).localeCompare(
              musicSourceOf(right, sources, accounts),
              "zh-CN"
            ) ||
            musicTitleOf(left).localeCompare(musicTitleOf(right), "zh-CN", { numeric: true })
          );
        }
        if (musicSort === "size-desc") {
          return (
            right.size - left.size ||
            musicTitleOf(left).localeCompare(musicTitleOf(right), "zh-CN", { numeric: true })
          );
        }
        if (musicSort === "size-asc") {
          return (
            left.size - right.size ||
            musicTitleOf(left).localeCompare(musicTitleOf(right), "zh-CN", { numeric: true })
          );
        }
        return musicTitleOf(left).localeCompare(musicTitleOf(right), "zh-CN", { numeric: true });
      });
  }, [accounts, scopedFiles, musicSort, sources]);

  const totalMusicCount = useMemo(
    () => scopedFiles.filter((file) => file.mediaKind === "music").length,
    [scopedFiles]
  );

  const visibleMusicFiles = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return musicFiles.filter(
      (file) =>
        !needle ||
        file.displayName.toLocaleLowerCase().includes(needle) ||
        (file.cloudPath ?? "").toLocaleLowerCase().includes(needle) ||
        musicFolderOf(file).toLocaleLowerCase().includes(needle)
    );
  }, [musicFiles, query]);

  return { musicFiles, totalMusicCount, visibleMusicFiles };
}
