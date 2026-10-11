import { useMemo } from "react";
import { ListMusic, Play, Shuffle } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { plural } from "../lib/format";
import { moveIds } from "../lib/playlists";
import type { MediaFile } from "../lib/nimbus";
import { usePlayer } from "../player/PlayerProvider";
import { EmptyState } from "../ui/controls";
import { SongTable } from "./MusicView";

type Props = { library: Library; playlistId: string; onNavigate: (route: Route) => void };

/** A playlist in its own order: play, shuffle, drag to reorder, Delete to remove. */
export function PlaylistView({ library, playlistId, onNavigate }: Props) {
  const player = usePlayer();
  const playlist = library.playlists.find((item) => item.id === playlistId);
  const songs = useMemo(
    () =>
      (playlist?.fileIds ?? [])
        .map((id) => library.filesById.get(id))
        .filter((file): file is MediaFile => file?.mediaKind === "music"),
    [library.filesById, playlist],
  );

  if (!playlist) {
    return (
      <div className="page">
        <EmptyState title={library.loaded ? "这个播放列表已不存在" : "正在载入…"} />
      </div>
    );
  }

  const missing = playlist.fileIds.length - songs.length;
  const remove = (files: MediaFile[]) => {
    const ids = new Set(files.map((file) => file.id));
    void library.setPlaylistOrder(
      playlist,
      playlist.fileIds.filter((id) => !ids.has(id)),
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">{playlist.name}</h1>
          <p className="page-subtitle">
            {songs.length ? plural(songs.length, "首歌曲") : "没有歌曲"}
            {missing > 0 && ` · ${missing} 首已不在资料库中`}
          </p>
        </div>
        <div className="page-actions">
          <button
            className="btn prominent large"
            disabled={!songs.length}
            onClick={() => void player.play(songs[0], { queue: songs, fromStart: true })}
          >
            <Play size={12} fill="currentColor" strokeWidth={0} />
            播放
          </button>
          <button className="btn large" disabled={songs.length < 2} onClick={() => player.playShuffled(songs)}>
            <Shuffle size={13} />
            随机播放
          </button>
        </div>
      </header>
      {songs.length ? (
        <SongTable
          songs={songs}
          onNavigate={onNavigate}
          resetKey={`playlist:${playlist.id}`}
          playlistId={playlist.id}
          onRemove={remove}
          onReorder={(ids, beforeId) => {
            const order = moveIds(playlist.fileIds, ids, beforeId);
            if (order !== playlist.fileIds) void library.setPlaylistOrder(playlist, order);
          }}
        />
      ) : (
        <EmptyState
          icon={<ListMusic size={44} strokeWidth={1.3} />}
          title="播放列表是空的"
          message="在音乐中右键点按歌曲，选择“添加到播放列表”，或把歌曲拖到边栏中的这个播放列表。"
        >
          <button className="btn" onClick={() => onNavigate({ name: "music" })}>
            前往音乐
          </button>
        </EmptyState>
      )}
    </div>
  );
}
