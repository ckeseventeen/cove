import type { MediaFile, MediaSource, Account, MovieMetadata } from "./nimbus";
type MovieCategory = "all" | "movie" | "tv" | "documentary" | "animation";
/** Decimal units, matching Finder. */
export function readableSize(bytes: number) {
  if (!bytes) return "大小未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  return `${(bytes / 1000 ** unit).toFixed(unit > 2 ? 1 : 0)} ${units[unit]}`;
}

export function providerName(accountId: string, accounts: Account[]) {
  const provider = accounts.find((account) => account.id === accountId)?.provider;
  return provider === "local" ? "本地磁盘" : provider === "baidu" ? "百度网盘" : provider === "google_drive" ? "Google Drive" : provider === "onedrive" ? "OneDrive" : "WebDAV";
}

export type MediaWork = { id: string; title: string; year?: string; files: MediaFile[]; seasons: number[]; isSeries: boolean };
const CATEGORY_FOLDER = /^(影视|电影|电视剧|动漫|动画|综艺|纪录片|豆瓣.*|.*(?:合集|榜|top\d+|最高分.*)|\d{4}(?:\s|$)|4k|1080p|720p|season\s*\d+|外挂)$/i;
/** Folders that hold one season: "第二季", "Season 2", "神探夏洛克S04", "冰与火之歌S03.冰雨的风暴". */
const SEASON_FOLDER = /第[零一二两三四五六七八九十百\d]+季|season\s*\d{1,2}|(?:^|[^a-z])s\d{1,2}(?!\d)/i;
const PURE_SEASON_FOLDER = /^(?:s\d+|season\s*\d+|第.+季)$/i;
/** Extras live in their own short-named folder ("花絮", "纪录+花絮", "Extras") and become season 0, shown as "特别篇". */
const EXTRAS_FOLDER = /^(?:.{0,6}(?:花絮|特辑|幕后|彩蛋).{0,6}|extras?|featurettes?|bonus|specials?)$/i;
/** "第二季", "第1-7季". */
const SEASON_WORD = String.raw`第[零一二两三四五六七八九十百\d\-~～至、]+季`;
const QUALITY = String.raw`4k|2160p?|1080p?|720p?|bluray|blu-ray|web-?dl|webrip|remux|hdr|hd`;
const RELEASE_TAG = String.raw`${QUALITY}|中字|双语|国语|粤语|简日|繁日|字幕`;
/** Leading tags such as 【台剧】 or [国语] that are not part of a title. */
const LEADING_TAG = /^[【\[](?:台剧|美剧|韩剧|日剧|英剧|港剧|泰剧|国产剧|国剧|国语|粤语|中字|双语|高清|超清|蓝光|4k|1080p|完结|全\d+集|更新至\d+集)[】\]]\s*/i;

export function stemOf(name: string) { return name.replace(/\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|flv|wmv|mp3|flac|m4a|aac|wav|ogg|opus|ape)$/i, ""); }
export function cleanWorkTitle(value: string) {
  return stemOf(value)
    // Characters inserted to dodge takedowns: 绝丨命毒师 → 绝命毒师.
    .replace(/(?<=[一-鿿])[丨｜|│](?=[一-鿿])/g, "")
    .replace(/^[a-z][~-]/i, "")
    .replace(LEADING_TAG, "")
    // Numbered collections: "10-死侍", "3、X战警".
    .replace(/^\d{1,2}[-、]\s*(?=\D)/, "")
    .replace(/[._]/g, " ")
    .replace(/(?<=[一-鿿])de(?=[一-鿿])/gi, "的")
    .replace(/(?<=[一-鿿])zhi(?=[一-鿿])/gi, "之")
    .replace(/(?<=[一-鿿])(?:di|le|yu|he|shi|bu|ba|bei|wei|cong|dao|dui|gen|gei|jiang|rang|zai|ye|dou|hai|jiu|cai|bing|huo|er|dan|que|ke|ze|na|nei|zhe|ji|suo|lv|lian|mei|ren|nv|ta)(?=[一-鿿])/gi, "")
    .replace(/[（(]\s*(?:4k|2160p?|1080p?|720p?|hd|蓝光|超清|高清|国语|粤语|中字|双语)[^）)]*[）)]/gi, " ")
    .replace(/[《》【】\[\]]/g, " ")
    // Release notes after the title: "沉默的羔羊 双语字幕 HR-HDTV", "地心抢险记 超清国英双语".
    .replace(/\s(?:中英|双语|国英|国语|粤语|中字|中文字幕|特效字幕|官方正式版|高码|超清|高清|蓝光).*$/, "")
    .replace(/\s(?:bd-?hr|hr-hdtv|hdtv|bdrip|x26[45]|h\.?26[45]|hevc|aac|ac3|dts(?:-hd)?|\d{3,4}x\d{3,4})\b.*$/i, "")
    .replace(/[ (（]+(?:19|20)\d{2}.*$/, "")
    .replace(new RegExp(String.raw`(?:[ ._-]*)(?:${QUALITY})\b.*$`, "i"), "")
    .replace(/[（(]\s*\d{1,2}\s*[）)]$/, "")
    .replace(new RegExp(String.raw`\s*(?:${SEASON_WORD}|season\s*\d{1,2}|(?<=[一-鿿\s])s\d{1,2})\s*$`, "i"), "")
    .replace(/[\s(（《._\-–—:：·]+$/, "")
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
const foldersOf = (file: MediaFile) => (file.cloudPath ?? "").split("/").filter(Boolean).slice(0, -1);
export function seasonOf(file: MediaFile) {
  if (EXTRAS_FOLDER.test(foldersOf(file).at(-1) ?? "")) return 0;
  const text = `${file.cloudPath ?? ""}/${file.displayName}`;
  const numeric = text.match(/(?:^|[^a-z])s(?:eason|e)?\s*0?(\d{1,2})(?!\d)/i)?.[1];
  return numeric ? Number(numeric) : chineseNumber(text.match(/第([零一二两三四五六七八九十\d]+)季/)?.[1] ?? "1");
}
/** Specials (season 0) sort after the regular seasons. */
export function compareSeasons(left: number, right: number) { return (left || 10_000) - (right || 10_000); }
export function seasonLabel(season: number) { return season === 0 ? "特别篇" : `第 ${season} 季`; }

/** Where an episode marker starts in a file name, and the episode number it gives. */
function episodeMatch(stem: string): { episode: number; at: number } | null {
  const zh = stem.match(/第([零一二两三四五六七八九十百千\d]+)[集话期回]/);
  if (zh?.index !== undefined) return { episode: chineseNumber(zh[1]), at: zh.index };
  const patterns: RegExp[] = [
    /s\d{1,2}[ ._-]?e(\d{1,3})/i,
    /(?<![a-z])se\d{1,2}[ ._-](\d{1,3})(?!\d)/i,
    /(?<![a-z])(?:ep|episode)[ ._-]?(\d{1,3})(?!\d)/i,
    /(?<![a-z])e(\d{1,3})(?!\d)/i,
    /[\[【（(](\d{1,3})[\]】）)](?!.*[\[【（(]\d)/,
    // "大明王朝1566HD1080P01": the number follows the resolution tag directly.
    /(?:hd|bd)?[ ._-]?(?:4k|2160p|1080p|720p)[ ._-]?(\d{2,3})$/i,
    new RegExp(String.raw`[ ._-]+(0\d{1,2}|\d{2,3})(?:$|[ ._-]+(?:${RELEASE_TAG}).*$)`, "i"),
    // "潜伏01": a zero-padded number right after a Chinese title. "唐人街探案3" stays a film.
    /(?<=[一-鿿])(0\d|\d{3})$/,
    new RegExp(String.raw`^(\d{1,3})(?:$|[ ._-]+(?:${RELEASE_TAG}).*$|HD.*$)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = stem.match(pattern);
    if (match?.index !== undefined) return { episode: Number(match[1]), at: match.index };
  }
  // Mini-series split into "Part1…Part4". A dated name ("…Part.1.2010") is a film in parts and stays a film.
  const part = /(?:19|20)\d{2}/.test(stem) ? null : stem.match(/(?<![a-z])part[ ._-]?(\d{1,2})(?!\d)/i);
  if (part?.index !== undefined) return { episode: Number(part[1]), at: part.index };
  return null;
}
export function episodeOf(file: MediaFile) { return episodeMatch(stemOf(file.displayName))?.episode ?? null; }

const usableTitle = (title: string) => !!title && !/^\d+$/.test(title) && !/^(4k|1080|2160|720)/i.test(title) && !/^s$/i.test(title);

/** The nearest folder that names the work: not a library category, a bare season folder or extras. */
function folderTitle(file: MediaFile) {
  for (const folder of foldersOf(file).reverse()) {
    if (CATEGORY_FOLDER.test(folder) || PURE_SEASON_FOLDER.test(folder) || EXTRAS_FOLDER.test(folder)) continue;
    let title = cleanWorkTitle(folder.replace(new RegExp(String.raw`(?:season\s*\d+|${SEASON_WORD}).*$`, "i"), ""));
    // "我们与恶的距离2" holding season 2 is the show "我们与恶的距离".
    const season = seasonOf(file);
    if (season > 1 && title.endsWith(String(season)) && /\D$/.test(title.slice(0, -String(season).length))) {
      title = title.slice(0, -String(season).length).trim();
    }
    if (usableTitle(title)) return title;
  }
  return null;
}

export function titleCandidateOf(file: MediaFile) {
  const stem = stemOf(file.displayName);
  const match = episodeMatch(stem);
  if (match) {
    const title = cleanWorkTitle(stem.slice(0, match.at));
    if (usableTitle(title)) return title;
    const folder = folderTitle(file);
    if (folder) return folder;
  }
  // Films may be named by a number alone: "300", "1917", "2012".
  const title = cleanWorkTitle(stem);
  if (title && !/^(4k|1080|2160|720)/i.test(title)) return title;
  return folderTitle(file) ?? stem;
}
export function episodeLabel(file: MediaFile, index: number) { return `第 ${episodeOf(file) ?? index + 1} 集`; }

/** The show folder above a season folder ("黑镜" above "《黑镜》第四季"), used to join shows named differently per season. */
function showFolderOf(file: MediaFile) {
  const folders = foldersOf(file);
  const seasonFolder = folders.at(-1);
  const show = folders.at(-2);
  if (!seasonFolder || !show || CATEGORY_FOLDER.test(show)) return null;
  if (!SEASON_FOLDER.test(seasonFolder) && !EXTRAS_FOLDER.test(seasonFolder)) return null;
  return { show: folders.slice(0, -1).join("/"), seasonFolder: folders.join("/") };
}

const titleKeyOf = (title: string) => title.toLocaleLowerCase().replace(/[\s·:：._\-【】\[\]（）()]+/g, "");

export function buildMovieWorks(movieFiles: MediaFile[]) {
  type Group = { files: MediaFile[]; titles: Map<string, number>; year: string; series: boolean };
  const groups = new Map<string, Group>();
  const showFolders = new Map<string, { groups: Set<string>; seasons: Map<string, number> }>();
  for (const file of movieFiles) {
    const series = episodeOf(file) !== null;
    const year = !series ? stemOf(file.displayName).match(/(?:19|20)\d{2}/)?.[0] ?? "" : "";
    const title = titleCandidateOf(file);
    const key = `${titleKeyOf(title)}:${year}`;
    const group: Group = groups.get(key) ?? { files: [], titles: new Map(), year, series: false };
    group.files.push(file);
    group.series ||= series;
    group.titles.set(title, (group.titles.get(title) ?? 0) + 1);
    groups.set(key, group);
    const folder = series ? showFolderOf(file) : null;
    if (folder) {
      const entry = showFolders.get(folder.show) ?? { groups: new Set(), seasons: new Map() };
      entry.groups.add(key);
      entry.seasons.set(folder.seasonFolder, seasonOf(file));
      showFolders.set(folder.show, entry);
    }
  }

  // Seasons of one show filed under different names (黑镜 / Black Mirror, 神探夏 / 神探夏洛克) join when
  // their season folders sit in one show folder, each season appears once, and no season is claimed twice.
  // A collection folder where every show is "S01" never qualifies.
  for (const { groups: keys, seasons } of showFolders.values()) {
    if (keys.size < 2) continue;
    const numbers = [...seasons.values()];
    if (new Set(numbers).size !== numbers.length) continue;
    const ordered = [...keys].map((key) => [key, groups.get(key)] as const).filter((entry): entry is readonly [string, Group] => !!entry[1] && entry[1].series);
    ordered.sort((left, right) => right[1].files.length - left[1].files.length);
    const [targetKey, target] = ordered[0] ?? [];
    if (!target || !targetKey) continue;
    const claimed = new Set(target.files.map(seasonOf));
    for (const [key, group] of ordered.slice(1)) {
      const groupSeasons = new Set(group.files.map(seasonOf));
      if ([...groupSeasons].some((season) => claimed.has(season))) continue;
      groupSeasons.forEach((season) => claimed.add(season));
      target.files.push(...group.files);
      group.titles.forEach((count, title) => target.titles.set(title, (target.titles.get(title) ?? 0) + count));
      groups.delete(key);
    }
  }

  return [...groups.entries()].map(([id, group]): MediaWork => {
    const files = group.files.sort((a, b) => compareSeasons(seasonOf(a), seasonOf(b)) || (episodeOf(a) ?? 9999) - (episodeOf(b) ?? 9999) || b.size - a.size);
    const seasons = [...new Set(files.map(seasonOf))].sort(compareSeasons);
    // The name most files agree on ("Game of Thrones" over "权力的游戏" when most seasons use it).
    const title = [...group.titles.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? titleCandidateOf(files[0]);
    return { id, title, year: group.year || undefined, files, seasons, isSeries: group.series };
  });
}
/** What to search TMDB for: the title, plus the year for films so remakes and sequels differ. */
export function lookupNameOf(work: MediaWork) { return !work.isSeries && work.year ? `${work.title} ${work.year}` : work.title; }
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
export function musicFolderOf(file: MediaFile) { const parts = (file.cloudPath || file.remotePath || "").split("/").filter(Boolean); return parts.at(-2) || "未分类"; }
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


/** Shared by global search and the music library so directory queries agree. */
export function matchesMusicQuery(file: MediaFile, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || [file.displayName, file.cloudPath, file.remotePath, musicFolderOf(file)]
    .some(value => value?.toLocaleLowerCase().includes(needle));
}

const PROVIDER_LABELS: Record<string, string> = {
  local: "本地磁盘",
  webdav: "WebDAV",
  baidu: "百度网盘",
  google_drive: "Google Drive",
  onedrive: "OneDrive",
  alidrive: "阿里云盘",
  quark: "夸克网盘",
};
export function providerLabel(provider: string) { return PROVIDER_LABELS[provider] ?? provider; }

/** "Artist - Title.flac" → { title, artist }; other names keep the whole stem as the title. */
export function songParts(file: MediaFile): { title: string; artist: string } {
  const stem = musicTitleOf(file);
  const match = stem.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return match ? { artist: match[1].trim(), title: match[2].trim() } : { title: stem, artist: "" };
}

/** Folder that holds a file, for "Show in Files". */
export function containingFolder(file: MediaFile) {
  const path = file.cloudPath || file.remotePath || "";
  if (!path.startsWith("/")) return null;
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
