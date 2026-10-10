// Formatting that follows the conventions of Finder and Music in a Chinese locale.

export function formatBytes(bytes: number, unknown = "--") {
  if (!bytes || bytes < 0) return unknown;
  if (bytes < 1000) return `${bytes} 字节`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Playback clock: m:ss, or h:mm:ss for long media. */
export function formatClock(seconds: number) {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = String(value % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

export function formatRemaining(position: number, duration: number) {
  const left = Math.max(0, duration - position);
  if (!duration) return "";
  if (left < 60) return "即将结束";
  const minutes = Math.round(left / 60);
  return minutes >= 60 ? `剩余 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `剩余 ${minutes} 分钟`;
}

const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const dateFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Finder-style modification date: 今天 14:20 / 昨天 09:12 / 2026年9月12日 14:20. */
export function formatDate(timestamp?: number | null, now = new Date()) {
  if (!timestamp) return "--";
  const date = new Date(timestamp * 1000);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  const time = timeFormat.format(date);
  if (days === 0) return `今天 ${time}`;
  if (days === 1) return `昨天 ${time}`;
  return `${dateFormat.format(date)} ${time}`;
}

/** Relative wording for "last scanned" style labels. */
export function formatRelative(timestamp?: number | null, now = Date.now()) {
  if (!timestamp) return "从未";
  const seconds = Math.max(0, Math.round(now / 1000 - timestamp));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86_400 * 7) return `${Math.floor(seconds / 86_400)} 天前`;
  return dateFormat.format(new Date(timestamp * 1000));
}

export function plural(count: number, unit: string) {
  return `${count.toLocaleString("zh-CN")} ${unit}`;
}
