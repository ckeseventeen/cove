//! Subtitle files that sit next to a video ("Movie.2019.chs.srt", "Subs/Movie.eng.srt"), found and
//! loaded when the video opens so they appear in the 字幕 menu without any setup.
use tauri::{AppHandle, Emitter, Manager};

use crate::{media_types, model::CloudEntry, AppState};

const SUBTITLE_EXTENSIONS: &[&str] = &["srt", "ass", "ssa", "vtt", "sup"];
/// Folders that release packs keep subtitles in, next to the video.
const SUBTITLE_FOLDERS: &[&str] = &["subs", "sub", "subtitles", "subtitle", "字幕"];
/// Enough for every language of one film; a folder of a whole season's subtitles is filtered first.
const MAX_TRACKS: usize = 8;
const MAX_SIZE: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Language {
    Simplified,
    Bilingual,
    /// No language in the name; in a Chinese library that is usually Chinese.
    Unknown,
    Traditional,
    English,
}

impl Language {
    pub fn title(self) -> &'static str {
        match self {
            Language::Simplified => "简体中文",
            Language::Bilingual => "中英双语",
            Language::Unknown => "外挂字幕",
            Language::Traditional => "繁体中文",
            Language::English => "英语",
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Language::English => "eng",
            _ => "chi",
        }
    }
}

fn extension(name: &str) -> Option<String> {
    name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase())
}

pub fn is_subtitle(name: &str) -> bool {
    extension(name).is_some_and(|ext| SUBTITLE_EXTENSIONS.contains(&ext.as_str()))
}

pub fn is_subtitle_folder(name: &str) -> bool {
    SUBTITLE_FOLDERS.contains(&name.trim().to_lowercase().as_str())
}

fn stem(name: &str) -> &str {
    name.rsplit_once('.').map_or(name, |(stem, _)| stem)
}

/// The language a subtitle's name announces: "chs", "简体", "zh-CN", "cht", "繁", "eng", "中英"…
pub fn language_of(name: &str) -> Language {
    let lower = stem(name).to_lowercase();
    let tokens: Vec<&str> = lower
        .split(|character: char| character.is_ascii_punctuation() || character.is_whitespace())
        .filter(|token| !token.is_empty())
        .collect();
    let has = |words: &[&str]| tokens.iter().any(|token| words.contains(token));
    let simplified = has(&["chs", "sc", "gb", "cn", "hans", "zhcn", "chi", "zho", "zh", "chinese"])
        || lower.contains("简")
        || tokens.iter().any(|token| token.starts_with("chs"));
    let traditional = has(&["cht", "tc", "big5", "tw", "hk", "hant", "zhtw", "zhhk"])
        || lower.contains("繁")
        || tokens.iter().any(|token| token.starts_with("cht"));
    // "chs&eng" splits into two tokens; "chseng" is one.
    let english = has(&["eng", "en", "english"])
        || tokens.iter().any(|token| (token.starts_with("chs") || token.starts_with("cht")) && token.ends_with("eng"));
    let both = lower.contains("双语") || lower.contains("中英") || lower.contains("简英") || lower.contains("繁英");
    if both || ((simplified || traditional) && english) {
        Language::Bilingual
    } else if traditional {
        Language::Traditional
    } else if simplified {
        Language::Simplified
    } else if english {
        Language::English
    } else {
        Language::Unknown
    }
}

/// The number of up to three digits starting at `start`, and where it ends.
fn number_at(text: &str, start: usize) -> Option<(u32, usize)> {
    let digits = text.get(start..)?.bytes().take_while(u8::is_ascii_digit).count();
    (1..=3).contains(&digits).then(|| (text[start..start + digits].parse().ok(), start + digits)).and_then(|(value, end)| Some((value?, end)))
}

/// "S01E03" → (1, 3); "E03", "EP03", "第3集" → (0, 3).
fn episode_of(name: &str) -> Option<(u32, u32)> {
    let lower = stem(name).to_lowercase();
    let bytes = lower.as_bytes();
    let starts_word = |index: usize| index == 0 || !bytes[index - 1].is_ascii_alphabetic();
    for index in (0..bytes.len()).filter(|&index| bytes[index] == b's' && starts_word(index)) {
        if let Some((season, end)) = number_at(&lower, index + 1) {
            let end = if matches!(bytes.get(end), Some(b'.' | b' ')) { end + 1 } else { end };
            if bytes.get(end) == Some(&b'e') {
                if let Some((episode, _)) = number_at(&lower, end + 1) {
                    return Some((season, episode));
                }
            }
        }
    }
    for index in (0..bytes.len()).filter(|&index| bytes[index] == b'e' && starts_word(index)) {
        let start = if lower[index..].starts_with("ep") { index + 2 } else { index + 1 };
        if let Some((episode, _)) = number_at(&lower, start) {
            return Some((0, episode));
        }
    }
    let (_, rest) = lower.split_once('第')?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let after = rest[digits..].chars().next();
    (digits > 0 && matches!(after, Some('集' | '话' | '回')))
        .then(|| rest[..digits].parse().ok())
        .flatten()
        .map(|episode| (0, episode))
}

fn same_episode(left: (u32, u32), right: (u32, u32)) -> bool {
    left.1 == right.1 && (left.0 == 0 || right.0 == 0 || left.0 == right.0)
}

/// The subtitles among `entries` that belong to `video`, best first. `entries` are the video's
/// folder (and any Subs folder in it); `videos_in_folder` counts the videos beside it.
pub fn pick<'a>(video: &str, entries: &'a [CloudEntry], videos_in_folder: usize) -> Vec<(&'a CloudEntry, Language)> {
    let video_stem = stem(video).to_lowercase();
    let video_episode = episode_of(video);
    let mut picked: Vec<(&CloudEntry, Language)> = entries
        .iter()
        .filter(|entry| !entry.is_dir && is_subtitle(&entry.name) && entry.size <= MAX_SIZE)
        .filter(|entry| {
            let subtitle_stem = stem(&entry.name).to_lowercase();
            if subtitle_stem.starts_with(&video_stem) {
                return true;
            }
            if videos_in_folder <= 1 {
                return true;
            }
            match (video_episode, episode_of(&entry.name)) {
                (Some(video), Some(subtitle)) => same_episode(video, subtitle),
                _ => false,
            }
        })
        .map(|entry| (entry, language_of(&entry.name)))
        .collect();
    // Best language first; then a subtitle named after this very release (most likely in sync);
    // then styled .ass before plain .srt; then by name for a stable order.
    let named = |entry: &CloudEntry| !stem(&entry.name).to_lowercase().starts_with(&video_stem);
    let plain = |entry: &CloudEntry| !matches!(extension(&entry.name).as_deref(), Some("ass" | "ssa"));
    picked.sort_by(|(left, left_language), (right, right_language)| {
        left_language
            .cmp(right_language)
            .then(named(left).cmp(&named(right)))
            .then(plain(left).cmp(&plain(right)))
            .then(left.name.cmp(&right.name))
    });
    picked.truncate(MAX_TRACKS);
    picked
}

/// Find, fetch and add the subtitles next to `file_id` while it plays. Runs after the video has
/// started, so a slow cloud listing never delays playback; it gives up quietly if anything fails.
pub(crate) async fn load(app: AppHandle, file_id: String) {
    let state = app.state::<AppState>();
    let Ok(file) = state.store.get_media_file(&file_id) else {
        return;
    };
    let path = file.cloud_path.clone().unwrap_or_else(|| file.remote_path.clone());
    let Some((folder, _)) = path.rsplit_once('/') else {
        return;
    };
    let folder = if folder.is_empty() { "/" } else { folder };
    let Ok(mut entries) = crate::commands::accounts::browse_directory(&state, &file.account_id, folder).await else {
        return;
    };
    let videos = entries.iter().filter(|entry| !entry.is_dir && media_types::is_video(&entry.name)).count();
    let subfolders: Vec<CloudEntry> = entries.iter().filter(|entry| entry.is_dir && is_subtitle_folder(&entry.name)).cloned().collect();
    for subfolder in subfolders {
        if let Ok(inner) = crate::commands::accounts::browse_directory(&state, &file.account_id, &subfolder.path).await {
            entries.extend(inner.into_iter().filter(|entry| !entry.is_dir));
        }
    }
    let picked = pick(&file.display_name, &entries, videos);
    if picked.is_empty() {
        return;
    }
    let mut tracks = Vec::new();
    for (entry, language) in &picked {
        if state.player.current_file_id().as_deref() != Some(file_id.as_str()) {
            return;
        }
        // Two tracks in one language are told apart by format ("简体中文 · ASS").
        let shared = picked.iter().filter(|(_, other)| other == language).count() > 1;
        let title = match extension(&entry.name) {
            Some(ext) if shared => format!("{} · {}", language.title(), ext.to_uppercase()),
            _ => language.title().to_owned(),
        };
        match crate::documents::local_copy(&app, &state, "subtitles", &file.account_id, &entry.path, &entry.id, &entry.name, entry.size).await {
            Ok(local) => tracks.push((local.to_string_lossy().into_owned(), title, language.code())),
            Err(error) => eprintln!("Cove: subtitle {} unavailable: {error}", entry.name),
        }
    }
    if let Ok(true) = state.player.add_external_subtitles(&file_id, &tracks).await {
        let snapshot = state.player.status().await;
        let _ = app.emit("nimbus-player-state", &snapshot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str) -> CloudEntry {
        CloudEntry {
            id: name.into(),
            path: format!("/影视/{name}"),
            name: name.into(),
            is_dir: false,
            size: 40_000,
            modified_at: None,
        }
    }

    fn names(picked: &[(&CloudEntry, Language)]) -> Vec<String> {
        picked.iter().map(|(entry, _)| entry.name.clone()).collect()
    }

    #[test]
    fn reads_the_language_from_common_names() {
        assert_eq!(language_of("Movie.2019.chs.srt"), Language::Simplified);
        assert_eq!(language_of("Movie.简体.ass"), Language::Simplified);
        assert_eq!(language_of("Movie.zh-CN.srt"), Language::Simplified);
        assert_eq!(language_of("Movie.cht.srt"), Language::Traditional);
        assert_eq!(language_of("Movie.繁体.srt"), Language::Traditional);
        assert_eq!(language_of("Movie.chs&eng.ass"), Language::Bilingual);
        assert_eq!(language_of("Movie.简英双语.srt"), Language::Bilingual);
        assert_eq!(language_of("Movie.eng.srt"), Language::English);
        assert_eq!(language_of("Movie.srt"), Language::Unknown);
        // "Scene" or "Chosen" contain the letters, not the tags.
        assert_eq!(language_of("The.Chosen.One.srt"), Language::Unknown);
    }

    #[test]
    fn a_single_film_takes_every_subtitle_best_first() {
        let entries = [
            entry("Movie.2019.1080p.mkv"),
            entry("Movie.2019.1080p.eng.srt"),
            entry("字幕.cht.srt"),
            entry("Movie.2019.1080p.chs.srt"),
            entry("Movie.2019.1080p.chs.ass"),
            entry("poster.jpg"),
        ];
        let picked = pick("Movie.2019.1080p.mkv", &entries, 1);
        assert_eq!(
            names(&picked),
            ["Movie.2019.1080p.chs.ass", "Movie.2019.1080p.chs.srt", "字幕.cht.srt", "Movie.2019.1080p.eng.srt"]
        );
    }

    #[test]
    fn a_season_folder_matches_by_name_or_episode() {
        let entries = [
            entry("Show.S01E01.mkv"),
            entry("Show.S01E02.mkv"),
            entry("Show.S01E01.chs.srt"),
            entry("Show.S01E02.chs.srt"),
            entry("Show.1x02.cht.srt"),
            entry("[字幕组] Show E02 简体.ass"),
            entry("Show.S02E02.chs.srt"),
        ];
        let picked = pick("Show.S01E02.mkv", &entries, 2);
        assert_eq!(names(&picked), ["Show.S01E02.chs.srt", "[字幕组] Show E02 简体.ass"]);
        let chinese = [entry("大明王朝 第02集.mkv"), entry("大明王朝 第02集.srt"), entry("大明王朝 第12集.srt")];
        assert_eq!(names(&pick("大明王朝 第02集.mkv", &chinese, 46)), ["大明王朝 第02集.srt"]);
    }

    #[test]
    fn folders_files_and_oversized_files_are_skipped() {
        let mut large = entry("Movie.chs.srt");
        large.size = MAX_SIZE + 1;
        let mut folder = entry("Movie.srt");
        folder.is_dir = true;
        assert!(pick("Movie.mkv", &[large, folder], 1).is_empty());
        assert!(is_subtitle_folder("Subs"));
        assert!(is_subtitle_folder("字幕"));
    }
}
