import { AudioLines, LoaderCircle, Music } from "lucide-react";
import { musicFolderOf, musicSourceOf, musicTitleOf, readableSize } from "../lib/media";
import type { Account, MediaFile, MediaSource } from "../lib/nimbus";

export type MusicSort = "title-asc" | "title-desc" | "folder" | "source" | "size-desc" | "size-asc";

type Props = {
  visibleFiles: MediaFile[];
  sources: MediaSource[];
  accounts: Account[];
  musicSort: MusicSort;
  onMusicSortChange: (sort: MusicSort) => void;
  pageSize: number;
  onLoadMore: () => void;
  nowPlayingId?: string;
  openingId: string | null;
  onPlayFile: (file: MediaFile) => void;
  query: string;
  onResetFilters?: () => void;
};

export function MusicView({
  visibleFiles,
  sources,
  accounts,
  musicSort,
  onMusicSortChange,
  pageSize,
  onLoadMore,
  nowPlayingId,
  openingId,
  onPlayFile,
  query,
  onResetFilters,
}: Props) {
  return (
    <>
      <div className="music-filterbar">
        <span>{query.trim() ? `找到 ${visibleFiles.length} 首` : `全部 ${visibleFiles.length} 首`}</span>
        <select
          aria-label="音乐排序"
          value={musicSort}
          onChange={(event) => onMusicSortChange(event.target.value as MusicSort)}
        >
          <option value="title-asc">歌曲名：A–Z</option>
          <option value="title-desc">歌曲名：Z–A</option>
          <option value="folder">按文件夹</option>
          <option value="source">按来源</option>
          <option value="size-desc">文件：从大到小</option>
          <option value="size-asc">文件：从小到大</option>
        </select>
      </div>
      <section className="music-library-list">
        <header>
          <span>#</span>
          <span>歌曲</span>
          <span>文件夹</span>
          <span>来源</span>
          <span>大小</span>
        </header>
        {visibleFiles.slice(0, pageSize).map((file, index) => (
          <button
            className={`music-list-row ${nowPlayingId === file.id ? "playing" : ""}`}
            key={file.id}
            onClick={() => onPlayFile(file)}
          >
            <span className="music-row-index">
              {openingId === file.id ? (
                <LoaderCircle className="spin" size={15} />
              ) : nowPlayingId === file.id ? (
                <AudioLines size={16} />
              ) : (
                String(index + 1)
              )}
            </span>
            <span className="music-row-title">
              <i>
                <Music size={17} />
              </i>
              <strong title={musicTitleOf(file)}>{musicTitleOf(file)}</strong>
              <small>{file.displayName.split(".").at(-1)?.toUpperCase() || "音频"}</small>
            </span>
            <span title={musicFolderOf(file)}>{musicFolderOf(file)}</span>
            <span title={musicSourceOf(file, sources, accounts)}>
              {musicSourceOf(file, sources, accounts)}
            </span>
            <span>{readableSize(file.size)}</span>
          </button>
        ))}
        {visibleFiles.length > pageSize && (
          <button className="button secondary load-more" onClick={onLoadMore}>
            显示更多歌曲（剩余 {visibleFiles.length - pageSize} 首）
          </button>
        )}
        {visibleFiles.length === 0 && (
          <div className="empty-library">
            <p>没有匹配的歌曲。可以搜索歌曲名、文件夹或路径。</p>
            {onResetFilters && (
              <button
                className="button secondary"
                style={{ marginTop: "12px" }}
                onClick={onResetFilters}
              >
                清空搜索与筛选
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
