import type { MediaSource, ScanResult } from './nimbus';

const UNITS: Record<MediaSource['kind'], string> = { movie: '个视频', music: '首歌曲', document: '份文档' };

const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/** What the toast says after a media folder is scanned: what it holds now, and what was left out. */
export function scanSummary(
  label: string,
  kind: MediaSource['kind'],
  result: Pick<ScanResult, 'mediaFiles' | 'truncated'> & { skippedDirectories?: string[] },
): { message: string; tone: 'success' | 'info' } {
  if (result.truncated) {
    return { message: `“${label}”只扫描了一部分，已保留原有索引。可以选择更小的文件夹后重试。`, tone: 'info' };
  }
  const updated = `“${label}”已更新，共 ${result.mediaFiles} ${UNITS[kind] ?? '个文件'}`;
  const skipped = result.skippedDirectories ?? [];
  if (!skipped.length) return { message: updated, tone: 'success' };
  const first = `“${folderName(skipped[0])}”`;
  const folders = skipped.length === 1 ? first : `${first}等 ${skipped.length} 个文件夹`;
  return { message: `${updated}。${folders}无法读取，已跳过，原有条目保留。`, tone: 'info' };
}

/** A background rescan speaks up only when something new arrived; removals and no-ops stay quiet. */
export function backgroundScanSummary(label: string, kind: MediaSource['kind'], added: number): string | null {
  return added > 0 ? `“${label}”新增 ${added} ${UNITS[kind] ?? '个文件'}` : null;
}
