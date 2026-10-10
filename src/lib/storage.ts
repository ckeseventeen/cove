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
export function validFolderName(name: string): boolean {
  const value = name.trim();
  return value.length > 0 && value !== '.' && value !== '..' && !/[\/\x00]/.test(value);
}

export type EntryKind = 'folder' | 'video' | 'audio' | 'document' | 'image' | 'text' | 'archive' | 'other';

const KINDS: [EntryKind, string, string[]][] = [
  ['video', '影片', ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'webm', 'm4v']],
  ['audio', '音频', ['mp3', 'flac', 'm4a', 'wav', 'aac', 'ogg', 'opus', 'ape']],
  ['image', '图像', ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'heic', 'tiff']],
  ['text', '文本', ['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'log', 'csv', 'xml', 'html', 'css', 'js', 'ts', 'rs', 'py', 'sh', 'toml', 'sql', 'srt', 'ass', 'lrc', 'nfo', 'ini']],
  ['document', '文稿', ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key', 'rtf', 'epub']],
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
    if (extensions.includes(extension)) return { kind, label: `${extension.toUpperCase()} ${label}` };
  }
  return { kind: 'other', label: extension ? `${extension.toUpperCase()} 文件` : '文稿' };
}

export const isPlayableKind = (kind: EntryKind) => kind === 'video' || kind === 'audio';
