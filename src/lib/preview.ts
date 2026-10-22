// Explicit browser-only QA data: /?demo=1. Never used inside the native app.
import type { Account, CloudEntry, MediaFile, MediaSource, MovieMetadata, MusicMetadata, Playlist, ReadingProgress, RecentPlayback } from './nimbus';

export const previewAccounts: Account[] = [
  { id: 'preview', provider: 'local', label: '本地磁盘', endpoint: '/', status: 'preview' },
  { id: 'preview-baidu', provider: 'baidu', label: '百度网盘', endpoint: '', status: 'preview' },
  { id: 'preview-dav', provider: 'webdav', label: '家庭 NAS', endpoint: 'https://nas.local/dav', status: 'preview' },
];

export const previewSources: MediaSource[] = [
  { id: 'movies', accountId: 'preview-baidu', kind: 'movie', remoteRoot: '/演示/电影', label: '电影与剧集', lastScanAt: 1789142400 },
  { id: 'songs', accountId: 'preview', kind: 'music', remoteRoot: '/演示/音乐', label: '音乐收藏', lastScanAt: 1789142400 },
  { id: 'docs', accountId: 'preview', kind: 'document', remoteRoot: '/演示/文档', label: '读书', lastScanAt: 1789142400 },
  { id: 'courses', accountId: 'preview-baidu', kind: 'course', remoteRoot: '/演示/网课', label: '网课', lastScanAt: 1789142400 },
];
const books = ['设计心理学.pdf', '人月神话.pdf', '置身事内.pdf', '万历十五年.pdf', '季度报告-2026Q3.pdf', '产品说明书.pdf'];

const names = [
  '海边的信.2024.mkv', '慢慢走.2022.mkv', '远山来客.2021.mkv', '黄昏之后.2020.mkv', '春日列车.2023.mkv',
  '小城记忆.2019.mkv', '漫长周末.2025.mkv', '第二种生活.2018.mkv', '云上旅行.S01E01.1080p.mkv',
  '云上旅行.S01E01.2160p.mkv', '云上旅行.S01E02.mkv',
  ...Array.from({ length: 10 }, (_, index) => `云上旅行.S01E${String(index + 3).padStart(2, '0')}.mkv`),
  ...Array.from({ length: 6 }, (_, index) => `云上旅行.S02E${String(index + 1).padStart(2, '0')}.mkv`),
];
const artists = ['林间', '晚风乐团', '安静的人', '北方以北', '盐与糖'];

export const previewFiles: MediaFile[] = [
  ...names.map((name, index): MediaFile => ({
    id: `movie-${index}`, accountId: 'preview-baidu', remotePath: `/演示/电影/${name}`, cloudPath: `/演示/电影/${name}`,
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
  ...books.map((name, index): MediaFile => ({
    id: `doc-${index}`, accountId: 'preview', remotePath: `/演示/文档/${index < 4 ? '书' : '工作'}/${name}`, cloudPath: `/演示/文档/${index < 4 ? '书' : '工作'}/${name}`,
    displayName: name, size: 1_200_000 + index * 2_300_000, sourceId: 'docs', sourceIds: ['docs'], mediaKind: 'document',
  })),
];

export const previewPlaylists: Playlist[] = [
  { id: 'playlist-commute', name: '通勤路上', fileIds: ['song-3', 'song-17', 'song-8', 'song-42', 'song-25', 'song-61'], updatedAt: 1789142400 },
  { id: 'playlist-night', name: '夜晚', fileIds: ['song-90', 'song-12', 'song-77'], updatedAt: 1789142000 },
];

/** Two courses: one with a wrapper folder and handouts, one with numbered chapters. */
const coursePaths = [
  ...Array.from({ length: 6 }, (_, index) => `机器学习量化实战/视频教程/第0${index + 1}章节、${['自动化交易综述', '量化交易系统综述', '搭建量化数据库', '金融数据分析', '策略建模概述', '模型评估与风险控制'][index]}.mp4`),
  '机器学习量化实战/课件/第01章 讲义.pdf',
  '【金程教育】【Python基础+量化进阶】基于Python的量化学习/01量化投资前导及课程介绍/1.AQF核心课程知识体系.mp4',
  '【金程教育】【Python基础+量化进阶】基于Python的量化学习/01量化投资前导及课程介绍/2.量化策略的python实现.mp4',
  ...Array.from({ length: 4 }, (_, index) => `【金程教育】【Python基础+量化进阶】基于Python的量化学习/02Python基础/${index + 1}.${['变量与类型', '循环与判断', '函数', '面向对象'][index]}.mp4`),
];
previewFiles.push(
  ...coursePaths.map((path, index): MediaFile => ({
    id: `course-${index}`, accountId: 'preview-baidu', remotePath: `/演示/网课/${path}`, cloudPath: `/演示/网课/${path}`,
    displayName: path.split('/').pop()!, size: 300_000_000 + index * 9_000_000, sourceId: 'courses', sourceIds: ['courses'], mediaKind: 'course',
  })),
);

export const previewReading: ReadingProgress[] = [
  { docKey: 'preview:/演示/文档/书/置身事内.pdf', accountId: 'preview', path: '/演示/文档/书/置身事内.pdf', entryId: '', name: '置身事内.pdf', size: 5_800_000, page: 86, pageCount: 312, updatedAt: 1789142500 },
  { docKey: 'preview:/演示/文档/书/设计心理学.pdf', accountId: 'preview', path: '/演示/文档/书/设计心理学.pdf', entryId: '', name: '设计心理学.pdf', size: 1_200_000, page: 12, pageCount: 280, updatedAt: 1789142000 },
];

export const previewMetadata: Record<string, MovieMetadata> = Object.fromEntries(names.map((name, index) => [`movie-${index}`, {
  tmdbId: index, mediaType: index >= 8 ? 'tv' : 'movie', title: name.split('.')[0], originalTitle: name.split('.')[0],
  year: 2025 - index % 7, overview: '这是一组用于检验界面布局的虚构媒体数据。一段平静的旅程，几位萍水相逢的人，在海边小城度过一个漫长的夏天。',
  rating: 7.1 + index % 3 / 2, genres: index % 4 === 0 ? ['剧情', '爱情'] : ['剧情'], cast: ['演示演员', '另一位演员', '第三位演员'],
}]));

export const previewRecent: RecentPlayback[] = [
  { fileId: 'movie-0', position: 1820, duration: 7200, updatedAt: 1789142400 },
  { fileId: 'movie-8', position: 650, duration: 2700, updatedAt: 1789142300 },
  { fileId: 'movie-1', position: 0, duration: 6100, updatedAt: 1789142250 },
  { fileId: 'course-0', position: 0, duration: 2400, updatedAt: 1789142350 },
  { fileId: 'course-1', position: 900, duration: 2600, updatedAt: 1789142360 },
  { fileId: 'song-3', position: 40, duration: 210, updatedAt: 1789142200 },
];

export function previewEntries(path: string): CloudEntry[] {
  const day = 1789142400;
  if (path === '/') return [{ id: '/演示', path: '/演示', name: '演示文件', isDir: true, size: 0, modifiedAt: day }];
  if (path === '/演示') {
    return [
      { id: '/演示/电影', path: '/演示/电影', name: '电影', isDir: true, size: 0, modifiedAt: day - 3600 },
      { id: '/演示/音乐', path: '/演示/音乐', name: '音乐', isDir: true, size: 0, modifiedAt: day - 7200 },
      { id: '/演示/文档', path: '/演示/文档', name: '文档', isDir: true, size: 0, modifiedAt: day - 9000 },
      { id: '/演示/说明.md', path: '/演示/说明.md', name: '说明.md', isDir: false, size: 1200, modifiedAt: day - 86_400 },
      { id: '/演示/年度计划.pdf', path: '/演示/年度计划.pdf', name: '年度计划.pdf', isDir: false, size: 860_000, modifiedAt: day - 86_400 * 2 },
      { id: '/演示/旅行.mp4', path: '/演示/旅行.mp4', name: '旅行.mp4', isDir: false, size: 640_000_000, modifiedAt: day - 86_400 * 4 },
      { id: '/演示/合影.heic', path: '/演示/合影.heic', name: '合影.heic', isDir: false, size: 3_100_000, modifiedAt: day - 86_400 * 5 },
      { id: '/演示/封面.jpg', path: '/演示/封面.jpg', name: '封面.jpg', isDir: false, size: 2_400_000, modifiedAt: day - 86_400 * 3 },
    ];
  }
  // Deeper levels are derived from the demo files: immediate subfolders first, then files.
  const prefix = `${path}/`;
  const below = previewFiles.filter((file) => file.remotePath.startsWith(prefix));
  const folders = [...new Set(below.map((file) => file.remotePath.slice(prefix.length)).filter((rest) => rest.includes('/')).map((rest) => rest.split('/')[0]))];
  return [
    ...folders.map((name): CloudEntry => ({ id: `${prefix}${name}`, path: `${prefix}${name}`, name, isDir: true, size: 0, modifiedAt: day })),
    ...below
      .filter((file) => !file.remotePath.slice(prefix.length).includes('/'))
      .map((file, index): CloudEntry => ({ id: file.id, path: file.remotePath, name: file.displayName, isDir: false, size: file.size, modifiedAt: day - index * 5000 })),
  ];
}

export function previewMusicMetadata(file: MediaFile): MusicMetadata {
  const stem = file.displayName.replace(/\.[^.]+$/, '');
  const [artist, title] = stem.includes(' - ') ? stem.split(' - ') : ['', stem];
  // One cover per album, as the music services return it.
  const album = file.remotePath.split('/').at(-2) ?? '';
  const hue = [...album].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},50%,32%)"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><circle cx="300" cy="300" r="150" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2"/><circle cx="300" cy="300" r="40" fill="rgba(255,255,255,.4)"/></svg>`;
  const lines = Array.from({ length: 36 }, (_, index) =>
    index % 5 === 4
      ? '这是一句很长的测试歌词，用来检查换行后内容是否完整显示，以及能否滚动到视野中央'
      : ['风经过窗边，音乐留在我的空间', '把今天写进一封信里', '寄给明天的自己', '夜色慢慢亮起来'][index % 4]);
  return {
    title, artist, album,
    artworkUrl: `data:image/svg+xml,${encodeURIComponent(artwork)}`,
    lyrics: lines.join('\n'),
    syncedLyrics: lines.map((line, index) => `[${String(Math.floor((index * 4 + 2) / 60)).padStart(2, '0')}:${String((index * 4 + 2) % 60).padStart(2, '0')}.00]${line}`).join('\n'),
  };
}
