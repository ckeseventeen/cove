import type { MediaFile, MovieMetadata } from "./nimbus";
type MovieCategory = "all" | "movie" | "tv" | "documentary" | "animation";
/** Decimal units, matching Finder. */
export function readableSize(bytes: number) {
  if (!bytes) return "大小未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  return `${(bytes / 1000 ** unit).toFixed(unit > 2 ? 1 : 0)} ${units[unit]}`;
}

export type MediaWork = { id: string; title: string; year?: string; files: MediaFile[]; seasons: number[]; isSeries: boolean };
const CATEGORY_FOLDER = /^(影视|电影|电视剧|动漫|动画|综艺|纪录片|豆瓣.*|.*(?:合集|榜|top\d+|最高分.*)|\d{4}(?:\s|$)|4k|1080p|720p|season\s*\d+|外挂)$/i;
const PURE_SEASON_FOLDER = /^(?:s\d+|season\s*\d+|第.+季)$/i;
/** Extras live in their own short-named folder ("花絮", "纪录+花絮", "Extras") and become season 0, shown as "特别篇". */
const EXTRAS_FOLDER = /^(?:.{0,6}(?:花絮|特辑|幕后|彩蛋).{0,6}|extras?|featurettes?|bonus|specials?)$/i;
/** Trailers, samples and featurettes beside a film; they are not works of their own. */
const FILM_EXTRAS_FOLDER = /^(?:trailers?|teasers?|samples?|deleted scenes|behind the scenes|interviews|shorts|featurettes?|extras?|预告片?)$/i;
/** "第二季", "第1-7季". */
const SEASON_WORD = String.raw`第[零一二两三四五六七八九十百\d\-~～至、]+季`;
/** A pack of seasons ("Friends.S01-S10", "Season 1-3") names no single season. */
const SEASON_RANGE = /(?:season\s*|s)\d{1,2}\s*[-~～–—]\s*(?:season\s*|s)?\d{1,2}(?!\d)/gi;
const QUALITY = String.raw`4k|2160p?|1080p?|720p?|bluray|blu-ray|web-?dl|webrip|remux|hdr|hd`;
const RELEASE_TAG = String.raw`${QUALITY}|中字|双语|国语|粤语|简日|繁日|字幕`;
/** Leading tags such as 【台剧】 or [国语] that are not part of a title. */
const LEADING_TAG = /^[【\[](?:台剧|美剧|韩剧|日剧|英剧|港剧|泰剧|国产剧|国剧|国语|粤语|中字|双语|高清|超清|蓝光|4k|1080p|完结|全\d+集|更新至\d+集)[】\]]\s*/i;
/** A release group or site in front of the title: "[电影天堂www.dytt89.com]", "[Sakurato] ", "阳光电影www.ygdy8.com.". */
const LEADING_GROUP = /^[\[【][^\]】]*[\]】]\s*(?=\S)/;
const LEADING_SITE = /^[^\s.\[【]*?www\.[\w-]+\.(?:com|net|org|cc|cn|me|tv|la)[ ._-]*/i;
/** A year, or a date or timestamp that starts with one ("20230101", "20230101123456"). */
const YEAR_WORD = String.raw`(?:19|20)\d{2}(?:[01]\d[0-3]\d\d*)?(?![\da-z])`;
/** One film on several files: "让子弹飞.CD1", "Disc 2". */
const DISC = /[ ._-]*\b(?:cd|dis[ck])[ ._-]?0?([1-9])$/i;

export function stemOf(name: string) { return name.replace(/\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|flv|wmv|mp3|flac|m4a|aac|wav|ogg|opus|ape)$/i, ""); }
export function cleanWorkTitle(value: string) {
  const stem = stemOf(value);
  const group = stem.match(LEADING_GROUP)?.[0] ?? "";
  const untagged = stem.slice(group.length).replace(LEADING_SITE, "");
  const title = untagged !== stem ? cleanTitleText(untagged) : "";
  // A title that is itself the first bracket keeps it: "[让子弹飞].2010", or "[让子弹飞] 2010" where only the release
  // year follows. A group or site followed by a film named by a year ("[YTS] 2012", "[电影天堂www.dytt89.com]2012") does not.
  const bracketTitle = /^(?:19|20)\d{2}$/.test(title) && !releaseYearOf(untagged) && /[一-鿿]/.test(group) && !/www\.|\.(?:com|net|org|cc|cn|me|tv|la)\b/i.test(group);
  return (bracketTitle && cleanTitleText(stem)) || title || cleanTitleText(stem);
}
function cleanTitleText(stem: string) {
  return stem
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
    // The release year is the last one: "Blade Runner 2049 2017" keeps 2049; "让子弹飞2010" drops it, and so does
    // an air date before the episode ("快乐大本营 20230101 第1期").
    .replace(new RegExp(String.raw`(?:[ (（]+|(?<=[一-鿿]))${YEAR_WORD}(?!.*(?:[ (（]|[一-鿿])${YEAR_WORD}).*$`, "i"), "")
    .replace(new RegExp(String.raw`(?:[ ._-]*)(?:(?:hd|bd)[ ._-]?)?(?:${QUALITY})\b.*$`, "i"), "")
    .replace(/[（(]\s*\d{1,2}\s*[）)]$/, "")
    .replace(DISC, "")
    .replace(new RegExp(String.raw`\s*(?:${SEASON_WORD}|season\s*\d{1,2}|(?<=[一-鿿\s])s\d{1,2}(?:\s*[-~～]\s*s?\d{1,2})?)\s*$`, "i"), "")
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
/** The one season a name holds: "S03E01", "SE03.01", "Season 2", "神探夏洛克S04", "冰与火之歌S03.冰雨的风暴", "第二季". */
function seasonIn(name: string): number | null {
  const single = name.replace(SEASON_RANGE, " ");
  const numeric = single.match(/season\s*0?(\d{1,2})(?!\d)|(?:^|[^a-z])se?0?(\d{1,2})(?=ep?\d|[^a-z\d]|$)/i);
  if (numeric) return Number(numeric[1] ?? numeric[2]);
  const chinese = single.match(/第([零一二两三四五六七八九十百\d]+)季/)?.[1];
  return chinese ? chineseNumber(chinese) : null;
}
export function seasonOf(file: MediaFile) {
  const folders = foldersOf(file);
  if (EXTRAS_FOLDER.test(folders.at(-1) ?? "")) return 0;
  // The file's own marker, else the nearer of its two folders. Folders farther up are libraries, drives or
  // accounts ("/Volumes/Seagate S2", "/Users/se7en"), and a pack ("Friends.S01-S10") names no season.
  for (const name of [stemOf(file.displayName), ...folders.slice(-2).reverse()]) {
    const season = seasonIn(name);
    if (season !== null) return season;
  }
  return 1;
}
/** Specials (season 0) sort after the regular seasons. */
export function compareSeasons(left: number, right: number) { return (left || 10_000) - (right || 10_000); }
export function seasonLabel(season: number) { return season === 0 ? "特别篇" : `第 ${season} 季`; }

/** Halves and extras of one variety episode stay apart and in order: "第1期上", "第1期（下）", "第1期 下", "第1期加更". */
const EPISODE_PART: Record<string, number> = { 上: 0.1, 中: 0.2, 下: 0.3, 加更: 0.5, 会员版: 0.6 };
/** Variety shows by air date: "快乐大本营.20230101", "奔跑吧 2023-10-27". A camera's timestamp ("VID_20230101_123456") is not one. */
const AIR_DATE = /[ ._-]*(?<!\d)((?:19|20)\d{2})([-._]?)(0[1-9]|1[0-2])\2(0[1-9]|[12]\d|3[01])(?!\d)(?![ ._-]?(?:at[ ._])?\d{2}[-.:]?\d{2}[-.:]?\d{2})/;

/** Where an episode marker starts in a file name, the episode number it gives, and its label when "第 N 集" does not fit. */
function episodeMatch(name: string): { episode: number; at: number; label?: string } | null {
  // "让子弹飞.Disc.02" is the second half of a film, not episode 2.
  const stem = name.replace(DISC, "");
  const zh = stem.match(/第([零一二两三四五六七八九十百千\d]+)([集话期回])(?:[ ._]?[（(]?([上中下])[）)]?[集篇部]?(?![一-鿿])|[ ._]?(加更|会员版))?/);
  if (zh?.index !== undefined) {
    const episode = chineseNumber(zh[1]);
    const part = zh[3] ?? zh[4];
    const unit = zh[2] === "期" ? "期" : "集";
    return { episode: episode + (part ? EPISODE_PART[part] : 0), at: zh.index, label: part || unit === "期" ? `第 ${episode} ${unit}${part ?? ""}` : undefined };
  }
  const patterns: RegExp[] = [
    /s\d{1,2}[ ._-]?e(\d{1,3})/i,
    /(?<![a-z])se\d{1,2}[ ._-](\d{1,3})(?!\d)/i,
    /(?<![a-z])(?:ep|episode)[ ._-]?(\d{1,3})(?!\d)/i,
    /(?<![a-z])e(\d{1,3})(?!\d)/i,
    AIR_DATE,
    // Fansub numbering: "[桜都字幕组] 葬送的芙莉莲 [01][1080P]"; a later bracketed number wins.
    /[\[【（(](\d{1,3})[\]】）)](?!.*[\[【（(]\d{1,3}[\]】）)])/,
    // "[Sakurato] Shingeki no Kyojin - 01 [1080P]", after a group tag so "Apollo 13 (1995)" stays a film.
    /(?<=^[\[【][^\]】]+[\]】].*?)\s[-–—]\s(\d{2,3})(?:v\d)?\s*(?=[\[【(（]|$)/,
    // "大明王朝1566HD1080P01": the number follows the resolution tag directly.
    /(?:hd|bd)?[ ._-]?(?:4k|2160p|1080p|720p)[ ._-]?(\d{2,3})$/i,
    new RegExp(String.raw`[ ._-]+(0\d{1,2}|\d{2,3})(?:$|[ ._-]+(?:${RELEASE_TAG}).*$)`, "i"),
    // "潜伏01": a zero-padded number right after a Chinese title. "唐人街探案3" stays a film.
    /(?<=[一-鿿])(0\d|\d{3})$/,
    new RegExp(String.raw`^(\d{1,3})(?:$|[ ._-]+(?:${RELEASE_TAG}).*$|HD.*$)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = stem.match(pattern);
    if (match?.index === undefined) continue;
    if (pattern === AIR_DATE) return { episode: Number(match[1] + match[3] + match[4]), at: match.index, label: `${match[1]}-${match[3]}-${match[4]}` };
    return { episode: Number(match[1]), at: match.index };
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
    // A show named by a number ("24", "1883") in a folder of that name, or in no named folder.
    if (/^\d+$/.test(title) && (!folder || foldersOf(file).slice(-2).some((name) => cleanWorkTitle(name) === title))) return title;
    if (folder) return folder;
  }
  // Films may be named by a number alone: "300", "1917", "2012".
  const title = cleanWorkTitle(stem);
  if (title && !/^(4k|1080|2160|720)/i.test(title)) return title;
  return folderTitle(file) ?? stem;
}
export function episodeLabel(file: MediaFile, index: number) {
  const match = episodeMatch(stemOf(file.displayName));
  return match?.label ?? `第 ${match?.episode ?? index + 1} 集`;
}
/** The number to show in a numbered episode list; null for an air date or a half ("第1期上"), shown by their label. */
export function episodeNumberOf(file: MediaFile) {
  const episode = episodeOf(file);
  return episode !== null && Number.isInteger(episode) && episode < 10_000 ? episode : null;
}

/** The show folder above a season folder ("黑镜" above "《黑镜》第四季"), used to join shows named differently per season. */
function showFolderOf(file: MediaFile) {
  const folders = foldersOf(file);
  const seasonFolder = folders.at(-1);
  const show = folders.at(-2);
  if (!seasonFolder || !show || CATEGORY_FOLDER.test(show)) return null;
  if (seasonIn(seasonFolder) === null && !EXTRAS_FOLDER.test(seasonFolder)) return null;
  return { show: folders.slice(0, -1).join("/"), seasonFolder: folders.join("/") };
}

const titleKeyOf = (title: string) => title.toLocaleLowerCase().replace(/[\s·:：._\-【】\[\]（）()]+/g, "");
/** The release year is the last one in a name ("Blade.Runner.2049.2017", "1917.2019"); a name that starts with one ("2012.mkv") is a title. */
function releaseYearOf(stem: string) {
  return [...stem.matchAll(/(?<![\da-z])(?:19|20)\d{2}(?![\da-z])/gi)].filter((match) => match.index).at(-1)?.[0] ?? "";
}
/** Which part of a film split across files this is: "让子弹飞.2010.CD2", "Disc 2", "….2010.Part2". 0 for a whole film. */
function filmPartOf(file: MediaFile) {
  const stem = stemOf(file.displayName);
  return Number((stem.match(DISC) ?? stem.match(/(?:19|20)\d{2}\b.*[ ._-]part[ ._-]?0?([1-9])$/i))?.[1] ?? 0);
}
/** How many copies of a film the library holds; the discs of a film in parts count once. */
export function versionCountOf(work: MediaWork) { return work.files.filter((file) => filmPartOf(file) <= 1).length; }
/** Samples, trailers and featurettes beside a film; an episode in an extras folder is a special and stays. */
function isFilmExtra(file: MediaFile) {
  if (/(?:^|[ ._-])(?:sample|trailer|teaser)$/i.test(stemOf(file.displayName))) return true;
  return FILM_EXTRAS_FOLDER.test(foldersOf(file).at(-1) ?? "") && episodeOf(file) === null;
}

export function buildMovieWorks(movieFiles: MediaFile[]) {
  type Group = { files: MediaFile[]; titles: Map<string, number>; year: string; series: boolean };
  const groups = new Map<string, Group>();
  const showFolders = new Map<string, { groups: Set<string>; seasons: Map<string, number> }>();
  for (const file of movieFiles) {
    if (isFilmExtra(file)) continue;
    const series = episodeOf(file) !== null;
    const year = !series ? releaseYearOf(stemOf(file.displayName)) : "";
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
    // A film in parts plays from CD1, not from the largest file.
    const files = group.files.sort((a, b) => compareSeasons(seasonOf(a), seasonOf(b)) || (episodeOf(a) ?? Infinity) - (episodeOf(b) ?? Infinity) || filmPartOf(a) - filmPartOf(b) || b.size - a.size);
    const seasons = [...new Set(files.map(seasonOf))].sort(compareSeasons);
    // The name most files agree on ("Game of Thrones" over "权力的游戏" when most seasons use it).
    const title = [...group.titles.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? titleCandidateOf(files[0]);
    return { id, title, year: group.year || undefined, files, seasons, isSeries: group.series };
  });
}
const EDITION = /\s*[（(]?((?:沪语|粤语|国语|普通话|台语|闽南语|方言|原声|导演剪辑|加长|未删减)版)[）)]?$/;
/** What to search TMDB for: the title without a dialect or cut ("繁花沪语版" → "繁花"), plus the year for films so remakes and sequels differ. */
export function lookupNameOf(work: MediaWork) {
  const title = work.title.replace(EDITION, "") || work.title;
  return !work.isSeries && work.year ? `${title} ${work.year}` : title;
}
/** The name to show: TMDB's title, keeping an edition the library tells apart ("繁花（沪语版）"). */
export function displayTitleOf(work: MediaWork, metadata?: { title?: string }) {
  if (!metadata?.title) return work.title;
  const edition = work.title.match(EDITION)?.[1];
  return edition ? `${metadata.title}（${edition}）` : metadata.title;
}
/** How the native side records a lookup in its cache: the kind of work and the name. */
export function lookupKeyOf(work: MediaWork) { return `${work.isSeries ? "tv" : "movie"}:${lookupNameOf(work)}`; }
export function uniqueEpisodes(files: MediaFile[]) { const seen = new Set<string>(); return files.filter(file => { const key = `${seasonOf(file)}:${episodeOf(file) ?? file.id}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
/** What the video controls step through: the Files folder it was played from while it is in it, else its series, else just itself. */
export function videoQueue(current: MediaFile, movieFiles: MediaFile[], playlist: MediaFile[]): { queue: MediaFile[]; work: MediaWork | null } {
  const work = buildMovieWorks(movieFiles).find((item) => item.files.some((file) => file.id === current.id)) ?? null;
  if (playlist.length > 1 && playlist.some((file) => file.id === current.id)) return { queue: playlist, work };
  if (!work?.isSeries) return { queue: [current], work };
  const episodes = uniqueEpisodes(work.files).map((file) => (seasonOf(file) === seasonOf(current) && (episodeOf(file) ?? file.id) === (episodeOf(current) ?? current.id) ? current : file));
  return { queue: episodes, work };
}
export function categoryOf(work: MediaWork, metadata?: MovieMetadata): Exclude<MovieCategory, "all"> {
  const path = work.files.map((file) => file.cloudPath ?? "").join(" ");
  if (metadata?.genres.includes("纪录片") || /纪录片|documentary/i.test(path)) return "documentary";
  if (metadata?.genres.includes("动画") || /动漫|动画|anime/i.test(path)) return "animation";
  if (metadata?.mediaType === "tv" || work.isSeries) return "tv";
  return "movie";
}
export function qualityOf(file: MediaFile) { const name = file.displayName.toLowerCase(); if (/4k|2160/.test(name)) return "4K"; if (/1080/.test(name)) return "1080p"; if (/720/.test(name)) return "720p"; return `${readableSize(file.size)}`; }
export function musicTitleOf(file: MediaFile) { return file.displayName.replace(/\.[^.]+$/, "").trim(); }
export function musicFolderOf(file: MediaFile) {
  const parts = (file.cloudPath || file.remotePath || "").split("/").filter(Boolean);
  const folder = parts.at(-2);
  // A disc folder is named with its album: "The Wall › CD1".
  return folder && /^(?:cd|dis[ck])\s*\d+$/i.test(folder) && parts.length > 2 ? `${parts.at(-3)} › ${folder}` : folder || "未分类";
}
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

/** "Artist - Title.flac" → { title, artist }; other names keep the whole stem as the title. A leading track
 * number ("01 - Adele - Hello", "01. Hello") becomes `track`; "99 Luftballons" and "311 - Amber" keep theirs. */
export function songParts(file: MediaFile): { title: string; artist: string; track?: number } {
  const stem = musicTitleOf(file);
  const numbered = stem.match(/^(\d{1,2}|0\d{2})\s*(?:[.、](?!\d)\s*|\s+[-–—]\s+)(.+)$/);
  const rest = numbered?.[2] ?? stem;
  const track = numbered ? Number(numbered[1]) : undefined;
  const match = rest.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return match ? { artist: match[1].trim(), title: match[2].trim(), track } : { title: rest.trim(), artist: "", track };
}
const albumCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
/** Album order within a folder: track number, then title. Folders of the same name ("CD1") stay apart. */
export function compareAlbumOrder(left: MediaFile, right: MediaFile) {
  const a = songParts(left);
  const b = songParts(right);
  return albumCollator.compare(containingFolder(left) ?? "", containingFolder(right) ?? "") || (a.track ?? Infinity) - (b.track ?? Infinity) || albumCollator.compare(a.title, b.title);
}

/** Folder that holds a file, for "Show in Files". */
export function containingFolder(file: MediaFile) {
  const path = file.cloudPath || file.remotePath || "";
  if (!path.startsWith("/")) return null;
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

type SavedPosition = { fileId: string; position: number; duration: number; updatedAt: number };
export type ResumeItem = SavedPosition & { file: MediaFile; work: MediaWork; upNext: boolean };
/**
 * 首页 › 继续播放: one entry per film or series, most recent first. The newest saved position of a work
 * decides: a video left part-way resumes there; a finished one (saved at 0:00) is left out, except that
 * a series moves on to the episode after it. Songs are not works, so they never appear.
 */
export function continueWatching(
  recent: SavedPosition[],
  filesById: ReadonlyMap<string, MediaFile>,
  workByFileId: ReadonlyMap<string, MediaWork>,
  limit = 6,
): ResumeItem[] {
  const savedById = new Map(recent.map((item) => [item.fileId, item]));
  const seen = new Set<string>();
  const items: ResumeItem[] = [];
  for (const item of [...recent].sort((left, right) => right.updatedAt - left.updatedAt)) {
    if (items.length >= limit) break;
    const file = filesById.get(item.fileId);
    const work = file && workByFileId.get(file.id);
    if (!file || !work || seen.has(work.id)) continue;
    seen.add(work.id);
    const finished = item.position <= 0 || (item.duration > 0 && item.position >= item.duration * 0.95);
    if (!finished) {
      items.push({ ...item, file, work, upNext: false });
      continue;
    }
    if (!work.isSeries) continue;
    // Another copy (quality) of an episode is the same episode.
    const sameEpisode = (left: MediaFile, right: MediaFile) =>
      left.id === right.id || (episodeOf(left) !== null && seasonOf(left) === seasonOf(right) && episodeOf(left) === episodeOf(right));
    const episodes = uniqueEpisodes(work.files);
    const index = episodes.findIndex((episode) => sameEpisode(episode, file));
    const next = index >= 0 ? episodes[index + 1] : undefined;
    if (!next) continue;
    // A copy of the next episode already begun resumes where it stopped.
    const begun = work.files
      .filter((copy) => sameEpisode(copy, next) && savedById.has(copy.id))
      .sort((left, right) => savedById.get(right.id)!.updatedAt - savedById.get(left.id)!.updatedAt)[0];
    const saved = begun && savedById.get(begun.id);
    items.push({
      fileId: (begun ?? next).id,
      position: saved?.position ?? 0,
      duration: saved?.duration ?? 0,
      updatedAt: item.updatedAt,
      file: begun ?? next,
      work,
      upNext: true,
    });
  }
  return items;
}
