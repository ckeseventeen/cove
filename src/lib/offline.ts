// Offline downloads as the interface shows them. Pure and unit-tested; only types come from elsewhere.
import type { OfflineProgress } from "./nimbus";

export type OfflineSummary = { done: number; active: number; total: number };

/** How many of `fileIds` are downloaded, still downloading (or waiting), out of how many. */
export function offlineSummary(fileIds: string[], offline: ReadonlyMap<string, OfflineProgress>): OfflineSummary {
  let done = 0;
  let active = 0;
  for (const id of fileIds) {
    const state = offline.get(id)?.state;
    if (state === "done") done++;
    else if (state === "queued" || state === "downloading") active++;
  }
  return { done, active, total: fileIds.length };
}

/** The menu entries for downloading some videos: start, cancel or remove, as their state allows. */
export function offlineActions(
  fileIds: string[],
  offline: ReadonlyMap<string, OfflineProgress>,
  labels: { download: string; remove: string },
): { label: string; kind: "download" | "cancel" | "remove"; ids: string[] }[] {
  const pending = fileIds.filter((id) => !offline.has(id) || offline.get(id)?.state === "failed");
  const active = fileIds.filter((id) => ["queued", "downloading"].includes(offline.get(id)?.state ?? ""));
  const done = fileIds.filter((id) => offline.get(id)?.state === "done");
  return [
    ...(pending.length ? [{ label: labels.download, kind: "download" as const, ids: pending }] : []),
    ...(active.length ? [{ label: "取消下载", kind: "cancel" as const, ids: active }] : []),
    ...(done.length ? [{ label: labels.remove, kind: "remove" as const, ids: done }] : []),
  ];
}

/** "1.2 GB / 3.4 GB" style progress as a fraction, for a ring or a bar. */
export function offlineFraction(progress: OfflineProgress | undefined) {
  if (!progress || progress.total <= 0) return 0;
  return Math.min(1, progress.received / progress.total);
}
