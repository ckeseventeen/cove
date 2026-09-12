import { ArrowUpRight, Cloud, FolderOpen, HardDrive, Plus } from 'lucide-react';
import type { Account } from '../lib/nimbus';
import { storageCapabilities } from '../lib/storage';
type Props = { accounts: Account[]; onBrowse: (id:string)=>void; onAdd:()=>void };
export function FilesView({accounts,onBrowse,onAdd}:Props) {
  return <section className="space-files">
    <header className="space-page-heading"><div><p className="eyebrow">YOUR FILES</p><h1>每个文件，都有归处。</h1><p>从本机到云盘，在一个空间里浏览、整理与打开。</p></div><button className="button primary" onClick={onAdd}><Plus size={17}/>连接存储</button></header>
    <div className="space-locations">{accounts.map(account => <button className="space-location" key={account.id} onClick={()=>onBrowse(account.id)}>
      <span className="space-location-icon">{account.provider === 'local' ? <HardDrive size={26}/> : <Cloud size={26}/>}</span>
      <span><strong>{account.label}</strong><small>{account.provider === 'local' ? '本机文件 · 系统应用打开' : storageCapabilities(account.provider).copy ? '云端文件 · 浏览与复制' : '云端文件 · 只读浏览'}</small></span><ArrowUpRight size={20}/>
    </button>)}</div>
    {!accounts.length && <div className="home-empty"><FolderOpen size={28}/><div><strong>连接你的第一个存储位置</strong><p>连接后可浏览文件，不需要先创建影音库。</p></div><button className="button secondary" onClick={onAdd}>连接存储</button></div>}
    <div className="space-file-note"><FolderOpen size={18}/><p>打开存储位置后可按名称查找文件、切换列表与网格视图。将喜欢的目录设为影音库，即可在影视或音乐中继续使用。</p></div>
  </section>;
}
