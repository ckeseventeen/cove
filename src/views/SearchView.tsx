import { Film, FolderOpen, Music, Search } from 'lucide-react';
import { useMemo } from 'react';
import type { Account, MediaFile, MediaSource } from '../lib/nimbus';
import { buildMovieWorks, musicTitleOf } from '../lib/media';
type Props = {query:string;files:MediaFile[];accounts:Account[];sources:MediaSource[];onPlay:(file:MediaFile)=>void;onBrowse:(id:string)=>void};
export function SearchView({query,files,accounts,sources,onPlay,onBrowse}:Props) {
  const needle=query.trim().toLocaleLowerCase();
  const matches=(value:string)=>value.toLocaleLowerCase().includes(needle);
  const works=useMemo(()=>buildMovieWorks(files.filter(file=>file.mediaKind==='movie')),[files]);
  const movies=works.filter(work=>matches(work.title)||work.files.some(file=>matches(file.displayName)));
  const songs=files.filter(file=>file.mediaKind==='music'&&matches(file.displayName));
  const locations=accounts.filter(account=>matches(account.label)||sources.some(source=>source.accountId===account.id&&matches(source.label)));
  return <section className="space-search"><header className="space-page-heading"><div><p className="eyebrow">SEARCH YOUR SPACE</p><h1>{needle ? `搜索“${query}”` : '寻找空间里的内容'}</h1><p>搜索已入库的影音与存储位置。其他文件请进入目录查找。</p></div></header>
    {needle && <>{!!locations.length && <section><h2><FolderOpen size={19}/>存储位置</h2><div className="space-search-results">{locations.map(account=><button key={account.id} onClick={()=>onBrowse(account.id)}><FolderOpen size={20}/><span>{account.label}</span></button>)}</div></section>}
    {!!movies.length && <section><h2><Film size={19}/>影视 · {movies.length}</h2><div className="space-search-results">{movies.slice(0,30).map(work=><button key={work.id} onClick={()=>onPlay(work.files[0])}><Film size={20}/><span>{work.title}<small>{work.files.length} 个文件</small></span></button>)}</div></section>}
    {!!songs.length && <section><h2><Music size={19}/>音乐 · {songs.length}</h2><div className="space-search-results">{songs.slice(0,30).map(file=><button key={file.id} onClick={()=>onPlay(file)}><Music size={20}/><span>{musicTitleOf(file)}</span></button>)}</div></section>}
    {!locations.length&&!movies.length&&!songs.length&&<div className="home-empty"><Search size={26}/><div><strong>没有找到相关内容</strong><p>试试更短的名称，或在文件入口中浏览存储位置。</p></div></div>}
    {(movies.length>30||songs.length>30)&&<p className="space-file-note">每类展示前 30 项，请补充关键词缩小范围。</p>}</>}
  </section>;
}
