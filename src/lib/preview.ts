// Explicit browser-only QA data: /?demo=1. Never used inside Tauri.
import type { Account, MediaFile, MediaSource, MovieMetadata, RecentPlayback } from './nimbus';
export const previewAccounts: Account[] = [{id:'preview',provider:'local',label:'演示媒体目录',endpoint:'/',status:'preview'}];
export const previewSources: MediaSource[] = [
  {id:'movies',accountId:'preview',kind:'movie',remoteRoot:'/演示/电影',label:'电影与剧集',lastScanAt:1789142400},
  {id:'songs',accountId:'preview',kind:'music',remoteRoot:'/演示/音乐',label:'音乐收藏',lastScanAt:1789142400},
];
const names=['海边的信.2024.mkv','慢慢走.2022.mkv','远山来客.2021.mkv','黄昏之后.2020.mkv','春日列车.2023.mkv','小城记忆.2019.mkv','漫长周末.2025.mkv','第二种生活.2018.mkv','云上旅行.S01E01.1080p.mkv','云上旅行.S01E01.2160p.mkv','云上旅行.S01E02.mkv'];
export const previewFiles: MediaFile[] = [
  ...names.map((name,index): MediaFile=>({id:`movie-${index}`,accountId:'preview',remotePath:`/演示/电影/${name}`,cloudPath:`/演示/电影/${name}`,displayName:name,size:2_000_000_000+index*1_000_000,sourceId:'movies',sourceIds:['movies'],mediaKind:'movie'})),
  ...Array.from({length:125},(_,index): MediaFile=>({id:`song-${index}`,accountId:'preview',remotePath:`/演示/音乐/午后/${index}.flac`,cloudPath:`/演示/音乐/午后/林间 - 风的来信 ${index+1}.flac`,displayName:`林间 - 风的来信 ${index+1}.flac`,size:32_000_000,sourceId:'songs',sourceIds:['songs'],mediaKind:'music'})),
];
export const previewMetadata: Record<string, MovieMetadata> = Object.fromEntries(names.map((name,index)=>[`movie-${index}`,{tmdbId:index,mediaType:index>=8?'tv':'movie',title:name.split('.')[0],originalTitle:name.split('.')[0],year:2025-index%7,overview:'这是一组用于检验界面布局的虚构媒体数据。',rating:7.1+index%3/2,genres:[],cast:['演示演员']} ]));
export const previewRecent: RecentPlayback[] = [{fileId:'movie-0',position:1820,duration:7200,updatedAt:1789142400},{fileId:'movie-8',position:650,duration:2700,updatedAt:1789142300}];

export function previewEntries(path: string) {
  if (path === '/') return [{id:'/演示',path:'/演示',name:'演示文件',isDir:true,size:0}];
  if (path === '/演示') return [{id:'/演示/电影',path:'/演示/电影',name:'电影',isDir:true,size:0},{id:'/演示/音乐',path:'/演示/音乐',name:'音乐',isDir:true,size:0},{id:'/演示/说明.md',path:'/演示/说明.md',name:'说明.md',isDir:false,size:120}];
  return previewFiles.filter(file=>file.remotePath.startsWith(path + '/')).map(file=>({id:file.id,path:file.remotePath,name:file.displayName,isDir:false,size:file.size}));
}
