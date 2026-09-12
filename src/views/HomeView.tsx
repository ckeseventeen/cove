import { useMemo } from "react";
import { ArrowUpRight, Clock3, Film, FolderPlus, FolderOpen, HardDrive, Cloud, Music2, Play } from "lucide-react";
import { formatTime, musicTitleOf, titleCandidateOf, buildMovieWorks } from "../lib/media";
import type { Account, MediaFile, MediaSource, RecentPlayback } from "../lib/nimbus";

type Props = {
  accounts: Account[];
  onFiles: () => void;
  onBrowse: (id:string) => void;
  files: MediaFile[];
  sources: MediaSource[];
  recent: RecentPlayback[];
  onPlay: (file: MediaFile) => void;
  onMovies: () => void;
  onMusic: () => void;
  onSources: () => void;
};

export function HomeView({
  accounts, onFiles, onBrowse,
  files,
  sources,
  recent,
  onPlay,
  onMovies,
  onMusic,
  onSources,
}: Props) {
  const movieCount = useMemo(
    () => buildMovieWorks(files.filter((file) => file.mediaKind === "movie")).length,
    [files]
  );
  const musicCount = useMemo(
    () => files.filter((file) => file.mediaKind === "music").length,
    [files]
  );

  const history = useMemo(() => {
    return recent.flatMap((item) => {
      const file = files.find((file) => file.id === item.fileId);
      return file ? [{ ...item, file }] : [];
    });
  }, [files, recent]);

  return (
    <div className="home-page">
      <header className="home-heading">
        <p className="eyebrow">YOUR PERSONAL SPACE</p>
        <h1>留一片空间，给自己。</h1>
        <p>文件、光影与音乐，在这里自然相遇。</p>
      </header>
      <section className="home-destinations">
        <button className="home-destination files" onClick={onFiles}><div className="destination-icon"><FolderOpen size={30}/></div><span className="destination-arrow"><ArrowUpRight size={24}/></span><span className="eyebrow">井然有序</span><h2>我的文件</h2><p>{accounts.length} 个存储位置 <span>·</span> 本机与云端</p></button>
        <button className="home-destination movies" onClick={onMovies}>
          <div className="destination-icon">
            <Film size={30} />
          </div>
          <span className="destination-arrow">
            <ArrowUpRight size={24} />
          </span>
          <span className="eyebrow">光影时刻</span>
          <h2>进入影视库</h2>
          <p>
            {movieCount} 部作品 <span>·</span> 按作品与剧集整理
          </p>
        </button>
        <button className="home-destination music" onClick={onMusic}>
          <div className="destination-icon">
            <Music2 size={30} />
          </div>
          <span className="destination-arrow">
            <ArrowUpRight size={24} />
          </span>
          <span className="eyebrow">此刻的声音</span>
          <h2>听点喜欢的</h2>
          <p>
            {musicCount} 首音乐 <span>·</span> 让音乐陪伴此刻
          </p>
        </button>
      </section>
      <section className="space-home-locations"><div className="home-section-title"><h2>存储位置</h2><button className="space-text-button" onClick={onFiles}>查看全部 <ArrowUpRight size={14}/></button></div><div className="space-location-pills">{accounts.slice(0,4).map(account=><button key={account.id} onClick={()=>onBrowse(account.id)}>{account.provider==='local'?<HardDrive size={19}/>:<Cloud size={19}/>}<span>{account.label}</span><ArrowUpRight size={15}/></button>)}</div></section>
      <section className="home-history">
        <div className="home-section-title">
          <h2>
            <Clock3 size={20} /> 最近播放
          </h2>
          <span>从上次停下的地方继续</span>
        </div>
        {history.length ? (
          <div className="history-grid">
            {history.map((item) => (
              <button className="history-card" key={item.fileId} onClick={() => onPlay(item.file)}>
                <span className="history-icon">
                  {item.file.mediaKind === "music" ? <Music2 /> : <Film />}
                </span>
                <span className="history-copy">
                  <strong>
                    {item.file.mediaKind === "music"
                      ? musicTitleOf(item.file)
                      : titleCandidateOf(item.file)}
                  </strong>
                  <small>
                    {item.position > 0 ? `已播放 ${formatTime(item.position)}` : "再次播放"}
                  </small>
                  <progress max={Math.max(item.duration, 1)} value={item.position} />
                </span>
                <Play size={17} />
              </button>
            ))}
          </div>
        ) : (
          <div className="home-empty">
            <Play size={24} />
            <div>
              <strong>下一段精彩，从这里开始</strong>
              <p>播放过的内容会出现在这里，方便随时继续。</p>
            </div>
            <button className="button secondary" onClick={movieCount ? onMovies : musicCount ? onMusic : onFiles}>
              {movieCount ? "浏览影视" : musicCount ? "浏览音乐" : "浏览文件"}
            </button>
          </div>
        )}
      </section>
      <button className="home-source-link" onClick={onSources}>
        <FolderPlus size={21} />
        <span>
          <strong>管理媒体来源</strong>
          <small>
            {sources.length
              ? `已连接 ${sources.length} 个目录 · 查看扫描状态与来源`
              : "连接网盘或本地目录，建立你的媒体库"}
          </small>
        </span>
        <ArrowUpRight size={19} />
      </button>
    </div>
  );
}
