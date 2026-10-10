// Explicit browser-only QA data: /?demo=1. Never used inside the native app.
import type { Account, CloudEntry, MediaFile, MediaSource, MovieMetadata, MusicMetadata, RecentPlayback } from './nimbus';

export const previewAccounts: Account[] = [
  { id: 'preview', provider: 'local', label: '本地磁盘', endpoint: '/', status: 'preview' },
  { id: 'preview-baidu', provider: 'baidu', label: '百度网盘', endpoint: '', status: 'preview' },
  { id: 'preview-dav', provider: 'webdav', label: '家庭 NAS', endpoint: 'https://nas.local/dav', status: 'preview' },
];

export const previewSources: MediaSource[] = [
  { id: 'movies', accountId: 'preview', kind: 'movie', remoteRoot: '/演示/电影', label: '电影与剧集', lastScanAt: 1789142400 },
  { id: 'songs', accountId: 'preview', kind: 'music', remoteRoot: '/演示/音乐', label: '音乐收藏', lastScanAt: 1789142400 },
];

const names = [
  '海边的信.2024.mkv', '慢慢走.2022.mkv', '远山来客.2021.mkv', '黄昏之后.2020.mkv', '春日列车.2023.mkv',
  '小城记忆.2019.mkv', '漫长周末.2025.mkv', '第二种生活.2018.mkv', '云上旅行.S01E01.1080p.mkv',
  '云上旅行.S01E01.2160p.mkv', '云上旅行.S01E02.mkv',
];
const artists = ['林间', '晚风乐团', '安静的人', '北方以北', '盐与糖'];

export const previewFiles: MediaFile[] = [
  ...names.map((name, index): MediaFile => ({
    id: `movie-${index}`, accountId: 'preview', remotePath: `/演示/电影/${name}`, cloudPath: `/演示/电影/${name}`,
    displayName: name, size: 2_000_000_000 + index * 1_000_000, sourceId: 'movies', sourceIds: ['movies'], mediaKind: 'movie',
  })),
  ...Array.from({ length: 125 }, (_, index): MediaFile => {
    const artist = artists[index % artists.length];
    const album = index % 2 ? '午后' : '夜航';
    const name = `${artist} - 风的来信 ${index + 1}.${index % 3 ? 'flac' : 'mp3'}`;
    return {
      id: `song-${index}`, accountId: 'preview', remotePath: `/演示/音乐/${album}/${name}`, cloudPath: `/演示/音乐/${album}/${name}`,
      displayName: name, size: 8_000_000 + (index % 9) * 3_100_000, sourceId: 'songs', sourceIds: ['songs'], mediaKind: 'music',
    };
  }),
];

export const previewMetadata: Record<string, MovieMetadata> = Object.fromEntries(names.map((name, index) => [`movie-${index}`, {
  tmdbId: index, mediaType: index >= 8 ? 'tv' : 'movie', title: name.split('.')[0], originalTitle: name.split('.')[0],
  year: 2025 - index % 7, overview: '这是一组用于检验界面布局的虚构媒体数据。一段平静的旅程，几位萍水相逢的人，在海边小城度过一个漫长的夏天。',
  rating: 7.1 + index % 3 / 2, genres: index % 4 === 0 ? ['剧情', '爱情'] : ['剧情'], cast: ['演示演员', '另一位演员', '第三位演员'],
}]));

export const previewRecent: RecentPlayback[] = [
  { fileId: 'movie-0', position: 1820, duration: 7200, updatedAt: 1789142400 },
  { fileId: 'movie-8', position: 650, duration: 2700, updatedAt: 1789142300 },
  { fileId: 'song-3', position: 40, duration: 210, updatedAt: 1789142200 },
];

export function previewEntries(path: string): CloudEntry[] {
  const day = 1789142400;
  if (path === '/') return [{ id: '/演示', path: '/演示', name: '演示文件', isDir: true, size: 0, modifiedAt: day }];
  if (path === '/演示') {
    return [
      { id: '/演示/电影', path: '/演示/电影', name: '电影', isDir: true, size: 0, modifiedAt: day - 3600 },
      { id: '/演示/音乐', path: '/演示/音乐', name: '音乐', isDir: true, size: 0, modifiedAt: day - 7200 },
      { id: '/演示/说明.md', path: '/演示/说明.md', name: '说明.md', isDir: false, size: 1200, modifiedAt: day - 86_400 },
      { id: '/演示/封面.jpg', path: '/演示/封面.jpg', name: '封面.jpg', isDir: false, size: 2_400_000, modifiedAt: day - 86_400 * 3 },
    ];
  }
  if (path === '/演示/音乐') {
    return ['午后', '夜航'].map((name) => ({ id: `${path}/${name}`, path: `${path}/${name}`, name, isDir: true, size: 0, modifiedAt: day }));
  }
  return previewFiles
    .filter((file) => file.remotePath.startsWith(path + '/') && !file.remotePath.slice(path.length + 1).includes('/'))
    .map((file, index) => ({ id: file.id, path: file.remotePath, name: file.displayName, isDir: false, size: file.size, modifiedAt: day - index * 5000 }));
}

export function previewMusicMetadata(file: MediaFile): MusicMetadata {
  const stem = file.displayName.replace(/\.[^.]+$/, '');
  const [artist, title] = stem.includes(' - ') ? stem.split(' - ') : ['', stem];
  const hue = [...file.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},50%,32%)"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><circle cx="300" cy="300" r="150" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2"/><circle cx="300" cy="300" r="40" fill="rgba(255,255,255,.4)"/></svg>`;
  const lines = Array.from({ length: 36 }, (_, index) =>
    index % 5 === 4
      ? '这是一句很长的测试歌词，用来检查换行后内容是否完整显示，以及能否滚动到视野中央'
      : ['风经过窗边，音乐留在我的空间', '把今天写进一封信里', '寄给明天的自己', '夜色慢慢亮起来'][index % 4]);
  return {
    title, artist, album: file.remotePath.split('/').at(-2) ?? '',
    artworkUrl: `data:image/svg+xml,${encodeURIComponent(artwork)}`,
    lyrics: lines.join('\n'),
    syncedLyrics: lines.map((line, index) => `[${String(Math.floor((index * 4 + 2) / 60)).padStart(2, '0')}:${String((index * 4 + 2) % 60).padStart(2, '0')}.00]${line}`).join('\n'),
  };
}
