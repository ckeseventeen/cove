export type RepeatMode = "off" | "all" | "one";
export function nextQueueIndex(index: number, length: number, repeat: RepeatMode, automatic = false): number | null {
  if (index < 0 || length === 0) return null;
  if (automatic && repeat === "one") return index;
  if (index + 1 < length) return index + 1;
  return repeat === "all" ? 0 : null;
}
export function shuffleUpcoming<T>(queue: T[], currentIndex: number, random = Math.random): T[] {
  if (currentIndex < 0) return [...queue];
  const remaining = queue.slice(currentIndex + 1);
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
  }
  return [...queue.slice(0, currentIndex + 1), ...remaining];
}
/** The level to unmute to: only a playing file's volume counts, not the empty status a stop reports. */
export function unmuteVolume(previous: number, status: { fileId?: string | null; volume: number }): number {
  return status.fileId && status.volume > 0 ? status.volume : previous;
}
