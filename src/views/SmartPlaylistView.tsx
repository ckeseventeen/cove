import { useMemo } from "react";
import { ListMusic, Play, Shuffle } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { plural } from "../lib/format";
import type { MediaFile, SmartListKind } from "../lib/nimbus";
import { usePlayer } from "../player/PlayerProvider";
import { EmptyState } from "../ui/controls";
import { SongTable } from "./MusicView";

export const SMART_LISTS: { kind: SmartListKind; title: string; note: string; empty: string }[] = [
  { kind: "recentlyAdded", title: "最近添加", note: "最近 30 天加入音乐资料库的歌曲", empty: "最近 30 天没有新加入的歌曲。" },
  { kind: "mostPlayed", title: "最常播放", note: "播放次数最多的歌曲", empty: "播放过的歌曲会出现在这里。" },
  { kind: "recentlyPlayed", title: "最近播放", note: "最近听过的歌曲", empty: "播放过的歌曲会出现在这里。" },
];

/** An automatic playlist: it keeps itself up to date, so it can be played but not edited. */
export function SmartPlaylistView({ library, list, onNavigate }: { library: Library; list: SmartListKind; onNavigate: (route: Route) => void }) {
  const player = usePlayer();
  const meta = SMART_LISTS.find((item) => item.kind === list)!;
  const songs = useMemo(
    () => library.smartLists[list].map((id) => library.filesById.get(id)).filter((file): file is MediaFile => !!file),
    [library.filesById, library.smartLists, list],
  );
  return (
    <div className="page">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">{meta.title}</h1>
          <p className="page-subtitle">
            {songs.length ? `${plural(songs.length, "首歌曲")} · ${meta.note}` : meta.note}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn prominent large" disabled={!songs.length} onClick={() => void player.play(songs[0], { queue: songs, fromStart: true })}>
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
        <SongTable songs={songs} onNavigate={onNavigate} resetKey={`smart:${list}`} />
      ) : (
        <EmptyState icon={<ListMusic size={44} strokeWidth={1.3} />} title={meta.title} message={meta.empty} />
      )}
    </div>
  );
}
