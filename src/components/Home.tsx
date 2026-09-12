import { ArrowUpRight, Film, Music2, Play, FolderPlus, Clock3 } from "lucide-react";
import { buildMovieWorks, titleCandidateOf, musicTitleOf, formatTime } from "../lib/media";
import type { MediaFile, MediaSource, RecentPlayback } from "../lib/nimbus";

export function Home({ files, sources, recent, onPlay, onMovies, onMusic, onSources }: {
  files: MediaFile[]; sources: MediaSource[]; recent: RecentPlayback[];
  onPlay: (file: MediaFile) => void; onMovies: () => void; onMusic: () => void; onSources: () => void;
}) {
  const works = buildMovieWorks(files.filter(file => file.mediaKind === "movie"));
  const music = files.filter(file => file.mediaKind === "music");
  const history = recent.flatMap(item => { const file = files.find(file => file.id === item.fileId); return file ? [{ ...item, file }] : []; });
  return <div className="home-page">
    <header className="home-heading"><p className="eyebrow">你的私人媒体空间</p><h1>好故事，随时继续。</h1><p>电影、剧集与音乐，都在这里。</p></header>
    <section className="home-destinations">
      <button className="home-destination movies" onClick={onMovies}><div className="destination-icon"><Film size={30}/></div><span className="destination-arrow"><ArrowUpRight size={24}/></span><span className="eyebrow">光影时刻</span><h2>进入影视库</h2><p>{works.length} 部作品 <span>·</span> 按作品与剧集整理</p></button>
      <button className="home-destination music" onClick={onMusic}><div className="destination-icon"><Music2 size={30}/></div><span className="destination-arrow"><ArrowUpRight size={24}/></span><span className="eyebrow">此刻的声音</span><h2>听点喜欢的</h2><p>{music.length} 首音乐 <span>·</span> 让音乐陪伴此刻</p></button>
    </section>
    <section className="home-history"><div className="home-section-title"><h2><Clock3 size={20}/> 最近播放</h2><span>从上次停下的地方继续</span></div>
      {history.length ? <div className="history-grid">{history.map(item => <button className="history-card" key={item.fileId} onClick={() => onPlay(item.file)}><span className="history-icon">{item.file.mediaKind === "music" ? <Music2/> : <Film/>}</span><span className="history-copy"><strong>{item.file.mediaKind === "music" ? musicTitleOf(item.file) : titleCandidateOf(item.file)}</strong><small>{item.position > 0 ? `已播放 ${formatTime(item.position)}` : "再次播放"}</small><progress max={Math.max(item.duration,1)} value={item.position}/></span><Play size={17}/></button>)}</div> : <div className="home-empty"><Play size={24}/><div><strong>下一段精彩，从这里开始</strong><p>播放过的内容会出现在这里，方便随时继续。</p></div><button className="button secondary" onClick={sources.length ? onMovies : onSources}>{sources.length ? "浏览影视" : "添加媒体来源"}</button></div>}
    </section>
    <button className="home-source-link" onClick={onSources}><FolderPlus size={21}/><span><strong>管理媒体来源</strong><small>{sources.length ? `已连接 ${sources.length} 个目录 · 查看扫描状态与来源` : "连接网盘或本地目录，建立你的媒体库"}</small></span><ArrowUpRight size={19}/></button>
  </div>;
}
