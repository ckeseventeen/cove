import type { MediaFile, MediaSource, Account, MovieMetadata } from "./nimbus";
type MovieCategory = "all" | "movie" | "tv" | "documentary" | "animation";
type MovieSort = "recent" | "oldest" | "rating" | "title";
type MusicSort = "title-asc" | "title-desc" | "folder" | "source" | "size-desc" | "size-asc";
type MusicPlayMode = "sequence" | "repeat-all" | "repeat-one" | "shuffle";
export function readableSize(bytes: number) {
  if (!bytes) return "大小未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit > 2 ? 1 : 0)} ${units[unit]}`;
}

export function providerName(accountId: string, accounts: Account[]) {
  const provider = accounts.find((account) => account.id === accountId)?.provider;
  return provider === "local" ? "本地磁盘" : provider === "baidu" ? "百度网盘" : provider === "google_drive" ? "Google Drive" : provider === "onedrive" ? "OneDrive" : "WebDAV";
}

export type MediaWork = { id: string; title: string; files: MediaFile[]; seasons: number[]; isSeries: boolean };
const CATEGORY_FOLDER = /^(影视|电影|电视剧|动漫|动画|综艺|纪录片|豆瓣.*|.*(?:合集|榜|top\d+)|\d{4}(?:\s|$)|4k|1080p|720p|season\s*\d+|外挂)$/i;
export function stemOf(name: string) { return name.replace(/\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|flv|wmv|mp3|flac|m4a|aac|wav|ogg|opus|ape)$/i, ""); }
export function cleanWorkTitle(value: string) {
  return stemOf(value).replace(/^[a-z][~-]/i, "")
    .replace(/[._]/g, " ")
    .replace(/(?<=[\u4e00-\u9fff])de(?=[\u4e00-\u9fff])/gi, "的")
    .replace(/(?<=[\u4e00-\u9fff])zhi(?=[\u4e00-\u9fff])/gi, "之")
    .replace(/(?<=[\u4e00-\u9fff])(?:di|le|yu|he|shi|bu|ba|bei|wei|cong|dao|dui|gen|gei|jiang|rang|zai|ye|dou|hai|jiu|cai|bing|huo|er|dan|que|ke|ze|na|nei|zhe|ji|suo|lv|lian|mei|ren|nv|ta)(?=[\u4e00-\u9fff])/gi, "")
    .replace(/[《》【】\[\]]/g, " ")
    .replace(/[ (（]+(?:19|20)\d{2}.*$/, "")
    .replace(/(?:[ ._-]*)(?:4k|2160p?|1080p?|720p?|bluray|blu-ray|web-?dl|webrip|remux|hdr|hd)\b.*$/i, "")
    .replace(/[（(]\s*\d{1,2}\s*[）)]$/, "")
    .replace(/\s+/g, " ").trim();
}
export function chineseNumber(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const digits: Record<string, number> = { 零:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  let result = 0;
  let current = 0;
  for (const char of text) {
    if (char === '百') { result += (current || 1) * 100; current = 0; }
    else if (char === '十') { result += (current || 1) * 10; current = 0; }
    else if (digits[char] !== undefined) { current = digits[char]; }
  }
  return result + current;
}
export function seasonOf(file: MediaFile) {
  const text = `${file.cloudPath ?? ""}/${file.displayName}`;
  const numeric = text.match(/(?:^|[^a-z])s(?:eason)?\s*0?(\d{1,2})(?!\d)/i)?.[1];
  return numeric ? Number(numeric) : chineseNumber(text.match(/第([零一二两三四五六七八九十\d]+)季/)?.[1] ?? "1");
}
export function episodeOf(file: MediaFile) {
  const name = stemOf(file.displayName);
  const zhMatch = name.match(/第([零一二两三四五六七八九十百千\d]+)[集话期回]/);
  if (zhMatch) return chineseNumber(zhMatch[1]);

  const match = name.match(/s\d{1,2}e(\d{1,3})/i)
    || name.match(/(?:^|[^a-z])(?:ep|episode)[ ._-]?(\d{1,3})(?:\D|$)/i)
    || name.match(/(?:^|[^a-z])e(\d{1,3})(?:\D|$)/i)
    || name.match(/[\[【（(](\d{1,3})[\]】）)](?!.*[\[【（(]\d)/)
    || name.match(/[ ._-]+(0\d{1,2}|\d{2,3})(?:$|[ ._-]+(?:4k|2160|1080|720|bluray|blu-ray|web|remux|hdr|hd|中字|双语|国语|粤语|简日|繁日|字幕).*$)/i)
    || name.match(/^(\d{1,3})(?:$|[ ._-]+(?:4k|2160p?|1080p?|720p?|bluray|blu-ray|web-?dl|webrip|remux|hdr|hd|中字|双语|国语|粤语|简日|繁日|字幕).*$|HD.*$)/i);
  return match ? Number(match[1]) : null;
}
export function titleCandidateOf(file: MediaFile) {
  const stem = stemOf(file.displayName);
  if (episodeOf(file) !== null) {
    const title = stem.replace(/[ ._-]*(?:s\d{1,2}e\d{1,3}|(?:ep|episode)[ ._-]?\d{1,3}|e\d{1,3}|第?[零一二两三四五六七八九十百千\d]+[集话期回]|[\[【（(]\d{1,3}[\]】）]|(?:0\d{1,2}|\d{2,3})(?:$|[ ._-]+(?:4k|2160|1080|720|bluray|web|remux|hdr|hd|中字|字幕).*$)).*$/i, "")
                      .replace(/^(\d{1,3})(?:$|[ ._-].*)/, "");
    const cleanedTitle = cleanWorkTitle(title);
    if (title !== stem && cleanedTitle && !/^\d+$/.test(cleanedTitle) && !/^(4k|1080|2160|720)/i.test(cleanedTitle)) {
      return cleanedTitle;
    }
    const folders = (file.cloudPath ?? "").split('/').filter(Boolean).slice(0, -1);
    const folder = folders.reverse().find(part => !CATEGORY_FOLDER.test(part) && !/^(s\d+|season\s*\d+|第.+季)$/i.test(part));
    if (folder) return cleanWorkTitle(folder.replace(/(?:s(?:eason)?\s*\d+|第.+季).*$/i, ""));
  }
  const title = cleanWorkTitle(stem);
  if (title && !/^(4k|1080|2160|720)/i.test(title)) return title;
  const folders = (file.cloudPath ?? "").split('/').filter(Boolean).slice(0, -1);
  const folder = folders.reverse().find(part => !CATEGORY_FOLDER.test(part));
  return cleanWorkTitle(folder ?? stem) || stem;
}
export function episodeLabel(file: MediaFile, index: number) { return `第 ${episodeOf(file) ?? index + 1} 集`; }
export function buildMovieWorks(movieFiles: MediaFile[]) {
  const groups = new Map<string, MediaFile[]>();
  for (const file of movieFiles) {
    const isEp = episodeOf(file) !== null;
    const year = !isEp ? stemOf(file.displayName).match(/(?:19|20)\d{2}/)?.[0] ?? "" : "";
    const titleKey = titleCandidateOf(file).toLocaleLowerCase().replace(/[\s·:：._\-【】\[\]（）()]+/g, "");
    const key = `${titleKey}:${year}`;
    const group = groups.get(key); if (group) group.push(file); else groups.set(key, [file]);
  }
  return [...groups.entries()].map(([id, grouped]): MediaWork => {
    const files = grouped.sort((a,b) => seasonOf(a)-seasonOf(b) || (episodeOf(a) ?? 9999)-(episodeOf(b) ?? 9999) || b.size-a.size);
    const seasons = [...new Set(files.map(seasonOf))].sort((a,b) => a-b);
    return { id, title: titleCandidateOf(files[0]), files, seasons, isSeries: files.some(file => episodeOf(file) !== null) };
  });
}
export function uniqueEpisodes(files: MediaFile[]) { const seen = new Set<string>(); return files.filter(file => { const key = `${seasonOf(file)}:${episodeOf(file) ?? file.id}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
export function categoryOf(work: MediaWork, metadata?: MovieMetadata): Exclude<MovieCategory, "all"> {
  const path = work.files.map((file) => file.cloudPath ?? "").join(" ");
  if (metadata?.genres.includes("纪录片") || /纪录片|documentary/i.test(path)) return "documentary";
  if (metadata?.genres.includes("动画") || /动漫|动画|anime/i.test(path)) return "animation";
  if (metadata?.mediaType === "tv" || work.isSeries) return "tv";
  return "movie";
}
export function episodeKey(name: string) { return name.match(/s\d{1,2}e\d{1,3}|第?\d{1,3}[集话]|^\d{1,3}/i)?.[0].toLowerCase() ?? name.replace(/\.[^.]+$/, "").replace(/4k|2160p|1080p|720p|remux|hdr|中字|字幕/gi, "").trim().toLowerCase(); }
export function qualityOf(file: MediaFile) { const name = file.displayName.toLowerCase(); if (/4k|2160/.test(name)) return "4K"; if (/1080/.test(name)) return "1080p"; if (/720/.test(name)) return "720p"; return `${readableSize(file.size)}`; }
export function musicTitleOf(file: MediaFile) { return file.displayName.replace(/\.[^.]+$/, "").trim(); }
export function musicFolderOf(file: MediaFile) { const parts = (file.cloudPath || file.remotePath).split("/").filter(Boolean); return parts.at(-2) || "未分类"; }
export function musicSourceOf(file: MediaFile, sources: MediaSource[], accounts: Account[]) { return sources.find((source) => source.id === file.sourceId)?.label || providerName(file.accountId, accounts); }
export function formatTime(seconds: number) { const value = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; }
export function parseSyncedLyrics(value?: string) {
  if (!value) return [] as { time: number; text: string }[];
  return value.split(/\r?\n/).flatMap((line) => {
    const stamps = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = line.replace(/\[[^\]]+\]/g, "").trim();
    return stamps.map((stamp) => ({ time: Number(stamp[1]) * 60 + Number(stamp[2]) + Number(`0.${stamp[3] ?? 0}`), text }));
  }).filter((line) => line.text).sort((a, b) => a.time - b.time);
}

