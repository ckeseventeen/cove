import { useMemo, useState } from "react";
import { Disc3, LoaderCircle, Play, Shuffle } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { plural } from "../lib/format";
import { groupAlbums, groupArtists, type AlbumEntry, type ArtistEntry } from "../lib/media";
import type { MediaFile } from "../lib/nimbus";
import { Artwork } from "../player/MiniPlayer";
import { usePlayer } from "../player/PlayerProvider";
import { EmptyState } from "../ui/controls";
import { SongTable } from "./MusicView";

/** A colour for an artist's initial, steady across launches. */
function avatarHue(name: string) {
  return [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
}

function ArtistAvatar({ artist, artworkUrl }: { artist: ArtistEntry; artworkUrl?: string | null }) {
  if (artworkUrl) return <Artwork url={artworkUrl} size={32} className="artist-avatar" />;
  return (
    <span className="artist-avatar initial" style={{ background: `hsl(${avatarHue(artist.name)} 38% 52%)` }} aria-hidden="true">
      {[...artist.name][0]?.toUpperCase()}
    </span>
  );
}

function PlayButtons({ songs }: { songs: MediaFile[] }) {
  const player = usePlayer();
  return (
    <div className="page-actions">
      <button className="btn prominent" disabled={!songs.length} onClick={() => void player.play(songs[0], { queue: songs, fromStart: true })}>
        <Play size={11} fill="currentColor" strokeWidth={0} />
        播放
      </button>
      <button className="btn" disabled={songs.length < 2} onClick={() => player.playShuffled(songs)}>
        <Shuffle size={12} />
        随机播放
      </button>
    </div>
  );
}

/** 艺人: the artists down the left, the chosen artist's songs on the right, as in Music. */
export function ArtistsBrowser({ songs, library, onNavigate }: { songs: MediaFile[]; library: Library; onNavigate: (route: Route) => void }) {
  const artists = useMemo(() => groupArtists(songs, library.songInfo), [songs, library.songInfo]);
  const [chosen, setChosen] = useState<string | null>(null);
  const artist = artists.find((item) => item.key === chosen) ?? artists[0];
  const artworkOf = (entry: ArtistEntry) => entry.songs.map((song) => library.songInfo.get(song.id)?.artworkUrl).find(Boolean);
  if (!artist) return null;

  const move = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = artists.indexOf(artist) + (event.key === "ArrowDown" ? 1 : -1);
    const next = artists[Math.max(0, Math.min(artists.length - 1, index))];
    setChosen(next.key);
    requestAnimationFrame(() => document.querySelector(`[data-artist="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: "nearest" }));
  };

  return (
    <div className="artist-browser">
      <div className="artist-list" role="listbox" aria-label="艺人" tabIndex={0} onKeyDown={move}>
        {artists.map((entry) => (
          <button
            key={entry.key}
            data-artist={entry.key}
            role="option"
            aria-selected={entry === artist}
            className="artist-row"
            tabIndex={-1}
            onClick={() => setChosen(entry.key)}
          >
            <ArtistAvatar artist={entry} artworkUrl={artworkOf(entry)} />
            <span className="truncate">{entry.name}</span>
            <span className="trailing">{entry.songs.length}</span>
          </button>
        ))}
      </div>
      <div className="artist-songs">
        <header className="artist-header">
          <div>
            <h2>{artist.name}</h2>
            <p className="secondary">{plural(artist.songs.length, "首歌曲")}</p>
          </div>
          <PlayButtons songs={artist.songs} />
        </header>
        <SongTable songs={artist.songs} onNavigate={onNavigate} resetKey={`artist:${artist.key}`} />
      </div>
    </div>
  );
}

/** 专辑: album covers from looked-up song details, with a lookup for songs not looked up yet. */
export function AlbumsGrid({
  songs,
  library,
  sourceId,
  onNavigate,
}: {
  songs: MediaFile[];
  library: Library;
  sourceId?: string;
  onNavigate: (route: Route) => void;
}) {
  const { albums, unknown } = useMemo(() => groupAlbums(songs, library.songInfo), [songs, library.songInfo]);
  const lookup = library.albumLookup;
  return (
    <>
      {(unknown > 0 || lookup) && (
        <div className="lookup-banner" role="status">
          <Disc3 size={16} />
          {lookup ? (
            <>
              <span>
                正在获取专辑信息… {lookup.done} / {lookup.total}
              </span>
              <span className="lookup-progress" aria-hidden="true">
                <span style={{ width: `${(lookup.done / Math.max(lookup.total, 1)) * 100}%` }} />
              </span>
              <button className="btn" onClick={library.stopAlbumLookup}>
                停止
              </button>
            </>
          ) : (
            <>
              <span>专辑与封面来自在线音乐资料库，还有 {unknown} 首歌曲没有专辑信息。</span>
              <button className="btn" onClick={() => void library.lookUpAlbums()}>
                获取专辑信息
              </button>
            </>
          )}
        </div>
      )}
      {albums.length ? (
        <div className="poster-grid albums">
          {albums.map((album) => (
            <button
              key={album.key}
              className="album-card"
              title={`${album.title} — ${album.artist}`}
              onClick={() => onNavigate({ name: "music", sourceId, album: album.key })}
            >
              <Artwork url={album.artworkUrl} size={180} className="album-art" />
              <span className="poster-title truncate">{album.title}</span>
              <span className="poster-subtitle truncate">{album.artist}</span>
            </button>
          ))}
        </div>
      ) : (
        !lookup && <EmptyState compact icon={<Disc3 size={40} strokeWidth={1.3} />} title="还没有专辑" message="获取专辑信息后，歌曲会按专辑排列在这里。" />
      )}
    </>
  );
}

/** One album: its cover, credits and songs. */
export function AlbumPage({
  songs,
  library,
  albumKey,
  sourceId,
  onNavigate,
}: {
  songs: MediaFile[];
  library: Library;
  albumKey: string;
  sourceId?: string;
  onNavigate: (route: Route) => void;
}) {
  const album: AlbumEntry | undefined = useMemo(
    () => groupAlbums(songs, library.songInfo).albums.find((item) => item.key === albumKey),
    [albumKey, library.songInfo, songs],
  );
  if (!album) {
    return (
      <div className="page">
        <EmptyState icon={library.loaded ? <Disc3 size={40} strokeWidth={1.3} /> : <LoaderCircle className="spin" size={22} />} title={library.loaded ? "这张专辑已不在资料库中" : "正在载入…"}>
          <button className="btn" onClick={() => onNavigate({ name: "music", sourceId })}>
            返回音乐
          </button>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="page">
      <header className="album-hero">
        <Artwork url={album.artworkUrl} size={180} className="album-art" />
        <div className="album-facts">
          <h1 className="large-title selectable">{album.title}</h1>
          <p className="album-artist">{album.artist}</p>
          <p className="secondary">{plural(album.songs.length, "首歌曲")}</p>
          <PlayButtons songs={album.songs} />
        </div>
      </header>
      <SongTable songs={album.songs} onNavigate={onNavigate} resetKey={`album:${album.key}`} />
    </div>
  );
}
