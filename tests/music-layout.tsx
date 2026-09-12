import React from 'react';
import { createRoot } from 'react-dom/client';
import { MusicPlayerBar } from '../src/components/MusicPlayerBar';
import '../src/styles.css';
import '../src/space.css';
import '../src/music-player.css';
const file = {id:'layout-fixture',accountId:'test',displayName:'歌词布局测试.mp3',remotePath:'/fixture.mp3',size:1,mediaKind:'music' as const};
const lines = Array.from({length: 40}, (_, i) => `${i + 1} · ${i % 3 === 0 ? '这是一句很长的测试歌词，用来检查换行后内容是否完整显示，以及最后一行能否滚动到视野中央。' : '风经过窗边，音乐留在我的空间。'}`);
const loadMetadata = async () => ({ title:'听见自己的空间',artist:'Cove · 布局测试',album:'长歌词与非方形封面测试',
artworkUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="#688d99"/><circle cx="400" cy="550" r="270" fill="#c8d7c2"/><circle cx="400" cy="550" r="130" fill="#dba38b"/></svg>'),
lyrics: lines.join('\n'), syncedLyrics: lines.map((line,i)=>`[${String(Math.floor(i*3/60)).padStart(2,'0')}:${String(i*3%60).padStart(2,'0')}.00]${line}`).join('\n') });
const subscribe: typeof import('../src/lib/nimbus').subscribePlayer = callback => {
let position = 0;
const tick = () => callback({fileId:file.id,running:true,paused:false,eofReached:false,position:position++,duration:120,speed:1,volume:70,tracks:[]});
tick(); const timer = setInterval(tick,1000); return () => clearInterval(timer);
};
createRoot(document.getElementById('root')!).render(<MusicPlayerBar metadataLoader={loadMetadata} playerSubscriber={subscribe} nowPlaying={file} playQueue={[file]} openingId={null} onOpenFile={()=>{}} onStop={()=>{}}/>);
