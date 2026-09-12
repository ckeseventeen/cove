use super::super::*;

#[tauri::command]
pub(crate) async fn music_metadata(
    file_id: String,
    refresh: Option<bool>,
    state: State<'_, AppState>,
) -> Result<metadata::MusicMetadata> {
    let cached = state
        .store
        .cached_metadata(&file_id, "music")?
        .and_then(|raw| serde_json::from_str::<metadata::MusicMetadata>(&raw).ok());
    if !refresh.unwrap_or(false) {
        if let Some(value) = cached.as_ref().filter(|value| music_cache_complete(value)) {
            return Ok(value.clone());
        }
    }
    let file = state.store.get_media_file(&file_id)?;
    let mut metadata = match metadata::music(&file.display_name).await {
        Ok(value) => value,
        Err(error) => return cached.ok_or(error),
    };
    if let Some(old) = cached {
        metadata.artwork_url = metadata.artwork_url.or(old.artwork_url);
        metadata.lyrics = metadata.lyrics.or(old.lyrics);
        metadata.synced_lyrics = metadata.synced_lyrics.or(old.synced_lyrics);
        if metadata.artist.is_empty() {
            metadata.artist = old.artist;
        }
        if metadata.album.is_empty() {
            metadata.album = old.album;
        }
    }
    state
        .store
        .save_metadata(&file_id, "music", &serde_json::to_string(&metadata)?)?;
    Ok(metadata)
}

fn music_cache_complete(value: &metadata::MusicMetadata) -> bool {
    value.artwork_url.is_some()
        && [value.lyrics.as_deref(), value.synced_lyrics.as_deref()]
            .into_iter()
            .flatten()
            .any(|text| !text.trim().is_empty())
}

#[cfg(test)]
mod music_cache_tests {
    use super::*;
    #[test]
    fn artwork_alone_does_not_suppress_lyrics_retry() {
        let mut value = metadata::MusicMetadata {
            title: "Song".into(),
            artist: "Artist".into(),
            album: "".into(),
            artwork_url: Some("cover".into()),
            lyrics: None,
            synced_lyrics: None,
        };
        assert!(!music_cache_complete(&value));
        value.synced_lyrics = Some("[00:01.00]A line".into());
        assert!(music_cache_complete(&value));
        value.synced_lyrics = Some("   ".into());
        assert!(!music_cache_complete(&value));
    }
}

pub(crate) fn looks_like_episode(stem: &str) -> bool {
    let lower = stem.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let season_episode = bytes.iter().enumerate().any(|(index, value)| {
        if *value != b's' || index + 3 >= bytes.len() || !bytes[index + 1].is_ascii_digit() {
            return false;
        }
        let mut cursor = index + 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() && cursor <= index + 2 {
            cursor += 1;
        }
        cursor + 1 < bytes.len() && bytes[cursor] == b'e' && bytes[cursor + 1].is_ascii_digit()
    });
    let e_episode = bytes.iter().enumerate().any(|(index, value)| {
        *value == b'e'
            && index + 1 < bytes.len()
            && bytes[index + 1].is_ascii_digit()
            && (index == 0 || !bytes[index - 1].is_ascii_alphabetic())
    });
    let ep_episode = bytes.iter().enumerate().any(|(index, value)| {
        if (index == 0 || !bytes[index - 1].is_ascii_alphabetic()) && *value == b'e' {
            let rem = &lower[index..];
            if rem.starts_with("episode") {
                let rest = rem[7..].trim_start_matches([' ', '.', '_', '-']);
                rest.chars().next().map_or(false, |c| c.is_ascii_digit())
            } else if rem.starts_with("ep") {
                let rest = rem[2..].trim_start_matches([' ', '.', '_', '-']);
                rest.chars().next().map_or(false, |c| c.is_ascii_digit())
            } else {
                false
            }
        } else {
            false
        }
    });
    let is_pure_episode_number = {
        let digits = stem
            .chars()
            .take_while(|value| value.is_ascii_digit())
            .count();
        if digits > 0 && digits <= 3 {
            let remainder = stem[digits..].trim_start_matches([' ', '.', '_', '-']);
            remainder.is_empty() || looks_like_generic_release(remainder)
        } else {
            false
        }
    };
    let chinese_episode = (stem.contains('集') || stem.contains('话'))
        && stem.chars().any(|value| value.is_ascii_digit());
    let bracket_episode = stem.contains('【')
        && stem.contains('】')
        && stem
            .split('【')
            .nth(1)
            .and_then(|s| s.split('】').next())
            .map_or(false, |s| {
                !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
            });
    season_episode
        || ep_episode
        || e_episode
        || is_pure_episode_number
        || chinese_episode
        || bracket_episode
}

pub(crate) fn looks_like_generic_release(stem: &str) -> bool {
    let lower = stem.trim().to_ascii_lowercase();
    [
        "4k", "2160", "1080", "720", "bluray", "blu-ray", "web-dl", "webrip", "remux", "hdr", "hd",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

pub(crate) fn episode_title(stem: &str) -> Option<&str> {
    let lower = stem.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let marker = bytes.iter().enumerate().find_map(|(index, value)| {
        if *value == b's' && index + 3 < bytes.len() && bytes[index + 1].is_ascii_digit() {
            let mut cursor = index + 1;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() && cursor <= index + 2 {
                cursor += 1;
            }
            if cursor + 1 < bytes.len()
                && bytes[cursor] == b'e'
                && bytes[cursor + 1].is_ascii_digit()
            {
                return Some(index);
            }
        }
        if (index == 0 || !bytes[index - 1].is_ascii_alphabetic()) && *value == b'e' {
            let rem = &lower[index..];
            if rem.starts_with("episode") {
                let rest = rem[7..].trim_start_matches([' ', '.', '_', '-']);
                if rest.chars().next().map_or(false, |c| c.is_ascii_digit()) {
                    return Some(index);
                }
            } else if rem.starts_with("ep") {
                let rest = rem[2..].trim_start_matches([' ', '.', '_', '-']);
                if rest.chars().next().map_or(false, |c| c.is_ascii_digit()) {
                    return Some(index);
                }
            } else if index + 1 < bytes.len() && bytes[index + 1].is_ascii_digit() {
                return Some(index);
            }
        }
        None
    });
    let marker = marker.or_else(|| {
        stem.find('【').and_then(|idx| {
            let rem = &stem[idx + '【'.len_utf8()..];
            rem.split('】')
                .next()
                .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
                .map(|_| idx)
        })
    })?;
    let title = stem[..marker].trim_end_matches([' ', '.', '_', '-']);
    (!title.is_empty() && !title.chars().all(|value| value.is_ascii_digit())).then_some(title)
}

#[cfg(test)]
mod media_name_tests {
    use super::{episode_title, looks_like_episode, looks_like_generic_release};

    #[test]
    fn recognizes_common_episode_names() {
        for name in [
            "S01E01",
            "企鹅人.S01E08.1080p",
            "Arcane Season1.E01",
            "万国志E01",
            "进击的巨人.EP01.1080p",
            "进击的巨人.EP.02.1080p",
            "繁花.Ep03.1080p",
            "示例剧.Episode.04.1080p",
            "进击的巨人.【05】",
            "第12集",
            "01",
            "01HD1080p",
            "02 - 1080p",
        ] {
            assert!(looks_like_episode(name), "did not recognize {name}");
        }
        assert!(!looks_like_episode("飞驰人生.Pegasus.2019"));
        assert!(!looks_like_episode("12.Monkeys.1995"));
        assert!(!looks_like_episode("300.2006"));
        assert!(!looks_like_episode("8.Mile.2002"));
        assert!(!looks_like_episode("1917.2019"));
        assert!(!looks_like_episode("500.Days.of.Summer.2009"));
    }

    #[test]
    fn recognizes_quality_only_movie_files() {
        assert!(looks_like_generic_release("4K WEB双语"));
        assert!(looks_like_generic_release("1080P.BluRay"));
        assert!(!looks_like_generic_release("沙丘2.2024.1080P"));
    }

    #[test]
    fn extracts_series_title_before_episode_marker() {
        assert_eq!(
            episode_title("Game.of.Thrones.S07E01.1080p"),
            Some("Game.of.Thrones")
        );
        assert_eq!(episode_title("进击的巨人.EP01.1080p"), Some("进击的巨人"));
        assert_eq!(episode_title("繁花.Ep02.1080p"), Some("繁花"));
        assert_eq!(episode_title("进击的巨人.【05】"), Some("进击的巨人"));
        assert_eq!(episode_title("轩辕剑之天之痕E01"), Some("轩辕剑之天之痕"));
        assert_eq!(
            episode_title("聊斋志异.2005.画皮.S01E07"),
            Some("聊斋志异.2005.画皮")
        );
        assert_eq!(episode_title("01"), None);
    }
}

#[tauri::command]
pub(crate) async fn movie_metadata(
    file_id: String,
    refresh: Option<bool>,
    lookup_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<metadata::MovieMetadata> {
    let manual = refresh.unwrap_or(false)
        && lookup_name
            .as_ref()
            .is_some_and(|name| !name.trim().is_empty());
    if !refresh.unwrap_or(false) {
        for cache_kind in ["movie-v4"] {
            if let Some(cached) = state.store.cached_metadata(&file_id, cache_kind)? {
                if let Ok(metadata) = serde_json::from_str(&cached) {
                    return Ok(metadata);
                }
            }
        }
    }
    let _permit = METADATA_GATE
        .acquire()
        .await
        .map_err(|_| NimbusError::Internal("Metadata scraper semaphore closed".into()))?;
    if !refresh.unwrap_or(false) {
        for cache_kind in ["movie-v4"] {
            if let Some(cached) = state.store.cached_metadata(&file_id, cache_kind)? {
                if let Ok(metadata) = serde_json::from_str(&cached) {
                    return Ok(metadata);
                }
            }
        }
    }
    let requested_name = if manual {
        lookup_name
    } else {
        state.store.metadata_override(&file_id)?.or(lookup_name)
    };
    let file = state.store.get_media_file(&file_id)?;
    let folder = file.cloud_path.as_deref().and_then(|path| {
        let mut parts = path
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        parts.pop();
        parts.into_iter().rev().find(|name| {
            let lower = name.to_ascii_lowercase();
            !matches!(
                lower.as_str(),
                "影视"
                    | "电影"
                    | "电视剧"
                    | "动漫"
                    | "动画"
                    | "综艺"
                    | "纪录片"
                    | "4k"
                    | "1080p"
                    | "720p"
                    | "season 1"
                    | "season 2"
                    | "season 3"
            ) && !lower.contains("最高分")
                && !lower.contains("奥斯卡")
                && !lower.contains("合集")
                && !lower.contains("花絮")
                && !lower.contains("纪录+")
                && !lower.starts_with("season ")
        })
    });
    let stem = file
        .display_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(&file.display_name);
    let lookup_name = if looks_like_episode(stem) {
        episode_title(stem).or(folder).unwrap_or(stem).to_owned()
    } else if looks_like_generic_release(stem) {
        folder.unwrap_or(stem).to_owned()
    } else {
        stem.to_owned()
    };
    let lookup_name = requested_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(lookup_name);
    let metadata = match metadata::movie(&lookup_name).await {
        Ok(metadata) => metadata,
        Err(primary_error) => {
            if let Some(folder_name) = folder.filter(|candidate| *candidate != lookup_name) {
                metadata::movie(folder_name)
                    .await
                    .map_err(|_| primary_error)?
            } else {
                return Err(primary_error);
            }
        }
    };
    if manual {
        state.store.save_metadata_override(&file_id, &lookup_name)?;
    }
    state
        .store
        .save_metadata(&file_id, "movie-v4", &serde_json::to_string(&metadata)?)?;
    Ok(metadata)
}
