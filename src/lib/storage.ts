import type { Account } from './nimbus';

/** Capabilities describe the implemented provider operations, not connection health. */
export function storageCapabilities(provider: string) {
  return {
    copy: provider === 'local' || provider === 'baidu',
    createFolder: provider === 'local' || provider === 'baidu',
    textPreview: provider === 'local',
    openNative: provider === 'local',
  };
}
export function canCopyBetween(source: Account, destination: Account): boolean {
  return (source.provider === 'local' && ['local', 'baidu'].includes(destination.provider)) ||
    (source.provider === 'baidu' && (destination.provider === 'local' ||
      (destination.provider === 'baidu' && source.id === destination.id)));
}
/** One folder however it is spelled: "/电影/" and "/电影" are the same media folder. */
export function samePath(left: string, right: string): boolean {
  const trimmed = (path: string) => path.replace(/\/+$/, '') || '/';
  return trimmed(left) === trimmed(right);
}
export function validFolderName(name: string): boolean {
  const value = name.trim();
  return value.length > 0 && value !== '.' && value !== '..' && !/[\/\x00]/.test(value);
}

export type EntryKind = 'folder' | 'video' | 'audio' | 'pdf' | 'document' | 'image' | 'text' | 'archive' | 'other';

const KINDS: [EntryKind, string, string[]][] = [
  ['video', '影片', ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'webm', 'm4v']],
  ['audio', '音频', ['mp3', 'flac', 'm4a', 'wav', 'aac', 'ogg', 'opus', 'ape']],
  ['image', '图像', ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'heic', 'tiff']],
  ['pdf', 'PDF 文稿', ['pdf']],
  ['text', '文本', ['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'log', 'csv', 'xml', 'html', 'css', 'js', 'ts', 'rs', 'py', 'sh', 'toml', 'sql', 'srt', 'ass', 'lrc', 'nfo', 'ini']],
  ['document', '文稿', ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key', 'rtf', 'epub']],
  ['archive', '归档', ['zip', 'rar', '7z', 'tar', 'gz', 'dmg', 'iso']],
];

export function extensionOf(name: string) {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

/** Finder-like "Kind" column. */
export function classifyEntry(name: string, isDir: boolean): { kind: EntryKind; label: string } {
  if (isDir) return { kind: 'folder', label: '文件夹' };
  const extension = extensionOf(name);
  for (const [kind, label, extensions] of KINDS) {
    if (extensions.includes(extension)) return { kind, label: kind === 'pdf' ? label : `${extension.toUpperCase()} ${label}` };
  }
  return { kind: 'other', label: extension ? `${extension.toUpperCase()} 文件` : '文稿' };
}

export const isPlayableKind = (kind: EntryKind) => kind === 'video' || kind === 'audio';

/** Finder's "Group by Kind": section order and titles. */
export const KIND_GROUPS: { kind: EntryKind; title: string }[] = [
  { kind: 'folder', title: '文件夹' },
  { kind: 'video', title: '影片' },
  { kind: 'audio', title: '音乐' },
  { kind: 'image', title: '图像' },
  { kind: 'pdf', title: 'PDF 文稿' },
  { kind: 'document', title: '文稿' },
  { kind: 'text', title: '文本' },
  { kind: 'archive', title: '归档' },
  { kind: 'other', title: '其他' },
];

/** Split an already-sorted list into kind sections, keeping the order inside each section. */
export function groupByKind<T extends { name: string; isDir: boolean }>(entries: T[]): { kind: EntryKind; title: string; entries: T[] }[] {
  const buckets = new Map<EntryKind, T[]>();
  for (const entry of entries) {
    const { kind } = classifyEntry(entry.name, entry.isDir);
    const bucket = buckets.get(kind);
    if (bucket) bucket.push(entry);
    else buckets.set(kind, [entry]);
  }
  return KIND_GROUPS.flatMap((group) => (buckets.has(group.kind) ? [{ ...group, entries: buckets.get(group.kind)! }] : []));
}
