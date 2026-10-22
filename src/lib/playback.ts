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

const LANGUAGE_NAMES: [RegExp, string][] = [
  [/^(chi|zho|zh|chs|cht|cn|cmn|yue)(-|$)/i, "中文"],
  [/^(eng|en)(-|$)/i, "英语"],
  [/^(jpn|ja)(-|$)/i, "日语"],
  [/^(kor|ko)(-|$)/i, "韩语"],
  [/^(fre|fra|fr)(-|$)/i, "法语"],
  [/^(ger|deu|de)(-|$)/i, "德语"],
  [/^(spa|es)(-|$)/i, "西班牙语"],
  [/^(rus|ru)(-|$)/i, "俄语"],
  [/^(ita|it)(-|$)/i, "意大利语"],
  [/^(tha|th)(-|$)/i, "泰语"],
];

/** "chi" → "中文"; unknown codes stay as they are. */
export function languageName(code: string) {
  return LANGUAGE_NAMES.find(([pattern]) => pattern.test(code.trim()))?.[1] ?? code.trim();
}

/** A track's menu label: its title, plus the language unless the title already names one. */
export function trackLabel(track: { id: number; title: string; language: string }, fallback: string) {
  const title = track.title && track.title !== "未命名轨道" ? track.title.trim() : "";
  const language = track.language ? languageName(track.language) : "";
  if (!title) return language || `${fallback} ${track.id}`;
  if (!language || title.includes(language) || /[一-鿿]/.test(title)) return title;
  return `${title} · ${language}`;
}
