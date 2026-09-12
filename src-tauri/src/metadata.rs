use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::{
    config::TmdbConfig,
    error::{NimbusError, Result},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovieMetadata {
    pub tmdb_id: i64,
    pub media_type: String,
    pub title: String,
    pub original_title: String,
    pub year: Option<i32>,
    pub overview: String,
    pub rating: f64,
    pub poster_url: Option<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub cast: Vec<String>,
}

#[derive(Deserialize)]
struct TmdbSearchResponse {
    #[serde(default)]
    results: Vec<TmdbSearchResult>,
}

#[derive(Deserialize)]
struct TmdbSearchResult {
    id: i64,
    #[serde(default)]
    media_type: String,
    title: Option<String>,
    name: Option<String>,
    original_title: Option<String>,
    original_name: Option<String>,
    release_date: Option<String>,
    first_air_date: Option<String>,
    #[serde(default)]
    overview: String,
    #[serde(default)]
    vote_average: f64,
    poster_path: Option<String>,
    #[serde(default)]
    genre_ids: Vec<i64>,
}

#[derive(Deserialize, Default)]
struct TmdbCreditsResponse {
    #[serde(default)]
    cast: Vec<TmdbCastMember>,
}

#[derive(Deserialize)]
struct TmdbCastMember {
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicMetadata {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork_url: Option<String>,
    pub lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LyricsRecord {
    track_name: String,
    #[serde(default)]
    artist_name: String,
    #[serde(default)]
    album_name: String,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItunesResponse {
    #[serde(default)]
    results: Vec<ItunesTrack>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItunesTrack {
    artwork_url100: Option<String>,
}

#[derive(Deserialize)]
struct NetEaseSearchResponse {
    result: Option<NetEaseSearchResult>,
}

#[derive(Deserialize)]
struct NetEaseSearchResult {
    songs: Option<Vec<NetEaseSong>>,
}

#[derive(Deserialize)]
struct NetEaseSong {
    id: u64,
    #[serde(default)]
    name: String,
    artists: Option<Vec<NetEaseArtist>>,
    album: Option<NetEaseAlbum>,
}

#[derive(Deserialize)]
struct NetEaseArtist {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct NetEaseAlbum {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct NetEaseLyricResponse {
    lrc: Option<NetEaseLrc>,
}

#[derive(Deserialize)]
struct NetEaseLrc {
    lyric: Option<String>,
}

fn clean_name(name: &str) -> String {
    let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
    stem.replace(['_', '.'], " ")
        .split_whitespace()
        .filter(|part| {
            !matches!(
                part.to_ascii_lowercase().as_str(),
                "flac" | "mp3" | "aac" | "320k" | "lossless"
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn movie_query(name: &str) -> (String, Option<String>) {
    let repaired = name
        .replace(['｜', '丨', '|'], "")
        .replace("聊斋Z异", "聊斋志异")
        .replace("轩辕J之天之痕", "轩辕剑之天之痕")
        .replace("豺狼de日子", "豺狼的日子");
    let stem = repaired
        .rsplit_once('.')
        .filter(|(_, extension)| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mkv" | "mp4" | "mov" | "avi" | "m4v" | "ts" | "webm" | "wmv"
            )
        })
        .map(|(stem, _)| stem)
        .unwrap_or(&repaired);
    let mut normalized = stem.replace(
        [
            '.', '_', '[', ']', '(', ')', '【', '】', '《', '》', '{', '}',
        ],
        " ",
    );
    if normalized.len() > 2 {
        let bytes = normalized.as_bytes();
        if bytes[0].is_ascii_alphabetic() && matches!(bytes[1], b'-' | b'~') {
            normalized = normalized[2..].trim_start().to_owned();
        }
    }
    let mut words = Vec::new();
    let mut year = None;
    for word in normalized.split_whitespace() {
        let lower = word.to_ascii_lowercase();
        if lower == "season"
            || lower.strip_prefix("season").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit())
            })
        {
            continue;
        }
        if word.ends_with('季') {
            if let Some(index) = word.rfind('第') {
                let title = word[..index].trim();
                if !title.is_empty() {
                    words.push(title);
                    break;
                }
                continue;
            }
        }
        if lower.starts_with('s')
            && lower.len() > 1
            && lower[1..].chars().all(|value| value.is_ascii_digit())
        {
            continue;
        }
        let character_starts = word
            .char_indices()
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if character_starts.len() > 4 {
            let split = character_starts[character_starts.len() - 4];
            let suffix = &word[split..];
            if suffix.chars().all(|value| value.is_ascii_digit())
                && (suffix.starts_with("19") || suffix.starts_with("20"))
            {
                let title = word[..split].trim_end_matches(['-', ' ', '.']);
                if !title.is_empty() {
                    words.push(title);
                }
                year = Some(suffix.to_owned());
                break;
            }
        }
        if word.len() == 4
            && word.chars().all(|value| value.is_ascii_digit())
            && (word.starts_with("19") || word.starts_with("20"))
        {
            year = Some(word.to_owned());
            break;
        }
        if lower.starts_with('s')
            && lower.contains('e')
            && lower[1..]
                .chars()
                .next()
                .is_some_and(|value| value.is_ascii_digit())
        {
            break;
        }
        if lower.contains("2160p")
            || lower.contains("1080p")
            || lower.contains("720p")
            || lower.contains("4k")
            || matches!(
                lower.as_str(),
                "4k" | "bluray"
                    | "blu-ray"
                    | "web-dl"
                    | "webrip"
                    | "remux"
                    | "hdr"
                    | "dv"
                    | "x264"
                    | "x265"
                    | "h264"
                    | "h265"
                    | "hevc"
            )
        {
            break;
        }
        if lower.chars().all(|value| value.is_ascii_digit()) && lower.len() <= 2 {
            continue;
        }
        if [
            "国语",
            "国语中字",
            "中字",
            "中文字幕",
            "双语",
            "双语字幕",
            "官方正式版",
            "高码",
        ]
        .iter()
        .any(|tag| lower.contains(tag))
        {
            continue;
        }
        let season_suffix = lower.rfind('s').filter(|index| {
            *index > 0
                && *index + 1 < lower.len()
                && lower[index + 1..]
                    .chars()
                    .all(|value| value.is_ascii_digit())
        });
        words.push(season_suffix.map(|index| &word[..index]).unwrap_or(word));
    }
    let query = words.join(" ").trim().to_owned();
    (
        if query.is_empty() {
            clean_name(name)
        } else {
            query
        },
        year,
    )
}

#[cfg(test)]
mod tests {
    use super::movie_query;

    #[test]
    fn extracts_clean_movie_queries() {
        assert_eq!(
            movie_query("飞驰人生.Pegasus.2019.CHINESE.1080p.BluRay.mkv"),
            ("飞驰人生 Pegasus".into(), Some("2019".into()))
        );
        assert_eq!(movie_query("年会不能停.国语中字.1080P.mp4").0, "年会不能停");
        assert_eq!(
            movie_query("【国语】疯K动物城.Zootopia.2016.BD2160P.mp4").0,
            "疯K动物城 Zootopia"
        );
        assert_eq!(movie_query("《驯鹿宝贝》(1).2024").0, "驯鹿宝贝");
        assert_eq!(movie_query("Z-装腔启示录").0, "装腔启示录");
        assert_eq!(movie_query("人生复本S1.2024").0, "人生复本");
        assert_eq!(movie_query("老练律师[S01][2024]").0, "老练律师");
        assert_eq!(movie_query("基督山伯爵2024").0, "基督山伯爵");
        assert_eq!(movie_query("谜探路德维希 第一季 [2024]").0, "谜探路德维希");
        assert_eq!(movie_query("庆余年第二季.2024").0, "庆余年");
        assert_eq!(movie_query("Arcane Season1").0, "Arcane");
        assert_eq!(movie_query("Game.of.Thrones").0, "Game of Thrones");
        assert_eq!(movie_query("聊｜斋Z异").0, "聊斋志异");
        assert_eq!(movie_query("轩丨辕J之天之痕").0, "轩辕剑之天之痕");
        assert_eq!(movie_query("豺狼de日子.2024").0, "豺狼的日子");
    }
}

pub async fn movie(name: &str) -> Result<MovieMetadata> {
    let config = TmdbConfig::load()?;
    let (query, year) = movie_query(name);
    if query.is_empty() {
        return Err(NimbusError::Validation("无法从文件名识别影视标题".into()));
    }
    let http = http()?;
    let mut request = http
        .get("https://api.themoviedb.org/3/search/multi")
        .bearer_auth(&config.read_access_token)
        .query(&[
            ("query", query.as_str()),
            ("language", "zh-CN"),
            ("include_adult", "false"),
        ]);
    if let Some(year) = year.as_deref() {
        request = request.query(&[("year", year)]);
    }
    let response = request.send().await?;
    if !response.status().is_success() {
        return Err(NimbusError::Validation(format!(
            "TMDB 刮削失败（HTTP {}）",
            response.status()
        )));
    }
    let mut results = response
        .json::<TmdbSearchResponse>()
        .await?
        .results
        .into_iter()
        .filter(|item| matches!(item.media_type.as_str(), "movie" | "tv"))
        .collect::<Vec<_>>();
    let preferred = year
        .as_deref()
        .and_then(|expected| {
            results.iter().position(|item| {
                item.release_date
                    .as_deref()
                    .or(item.first_air_date.as_deref())
                    .is_some_and(|date| date.starts_with(expected))
            })
        })
        .or_else(|| {
            let expected = query.to_ascii_lowercase();
            results.iter().position(|item| {
                item.title
                    .as_deref()
                    .or(item.name.as_deref())
                    .is_some_and(|title| title.to_ascii_lowercase() == expected)
            })
        })
        .unwrap_or(0);
    let result = (!results.is_empty())
        .then(|| results.remove(preferred))
        .ok_or_else(|| NimbusError::Validation(format!("TMDB 未找到：{query}")))?;
    let date = result.release_date.or(result.first_air_date);
    let parsed_year = date
        .as_deref()
        .and_then(|value| value.get(..4))
        .and_then(|value| value.parse().ok());
    let genres = result
        .genre_ids
        .iter()
        .filter_map(|id| match id {
            16 => Some("动画"),
            99 => Some("纪录片"),
            10751 => Some("家庭"),
            10762 => Some("儿童"),
            10759 => Some("动作冒险"),
            18 => Some("剧情"),
            35 => Some("喜剧"),
            80 => Some("犯罪"),
            9648 => Some("悬疑"),
            878 => Some("科幻"),
            _ => None,
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let credits_url = format!(
        "https://api.themoviedb.org/3/{}/{}/credits",
        result.media_type, result.id
    );
    let cast = match http
        .get(credits_url)
        .bearer_auth(&config.read_access_token)
        .query(&[("language", "zh-CN")])
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response
            .json::<TmdbCreditsResponse>()
            .await
            .unwrap_or_default()
            .cast
            .into_iter()
            .take(12)
            .map(|member| member.name)
            .collect(),
        _ => Vec::new(),
    };
    Ok(MovieMetadata {
        tmdb_id: result.id,
        media_type: result.media_type,
        title: result
            .title
            .or(result.name)
            .unwrap_or_else(|| query.clone()),
        original_title: result
            .original_title
            .or(result.original_name)
            .unwrap_or_default(),
        year: parsed_year,
        overview: result.overview,
        rating: result.vote_average,
        poster_url: result
            .poster_path
            .map(|path| format!("https://image.tmdb.org/t/p/w500{path}")),
        genres,
        cast,
    })
}

pub async fn music(name: &str) -> Result<MusicMetadata> {
    let query = clean_name(name);
    if query.is_empty() {
        return Err(NimbusError::Validation("无法从文件名识别歌曲".into()));
    }
    let direct = http_direct().unwrap_or_else(|_| http().expect("http client"));
    let sys_http = http()?;

    let lyrics_request = async {
        // First try lrclib.net direct (has synced lyrics + metadata)
        if let Ok(response) = direct
            .get("https://lrclib.net/api/search")
            .query(&[("q", query.as_str())])
            .send()
            .await
        {
            if response.status().is_success() {
                if let Ok(records) = response.json::<Vec<LyricsRecord>>().await {
                    if let Some(first) = records.into_iter().next() {
                        if first.synced_lyrics.is_some() || first.plain_lyrics.is_some() {
                            return Some(first);
                        }
                    }
                }
            }
        }
        // Fallback: NetEase Music search & lyrics
        if let Ok(response) = direct
            .get("https://music.163.com/api/search/get/web")
            .query(&[("s", query.as_str()), ("type", "1"), ("limit", "1")])
            .send()
            .await
        {
            if response.status().is_success() {
                if let Ok(data) = response.json::<NetEaseSearchResponse>().await {
                    if let Some(song) = data
                        .result
                        .and_then(|r| r.songs)
                        .and_then(|s| s.into_iter().next())
                    {
                        let artist_name = song
                            .artists
                            .and_then(|a| a.into_iter().next().map(|x| x.name))
                            .unwrap_or_default();
                        let album_name = song.album.map(|a| a.name).unwrap_or_default();
                        let lyric_url = format!(
                            "https://music.163.com/api/song/lyric?id={}&lv=-1&kv=-1&tv=-1",
                            song.id
                        );
                        let mut synced_lyrics = None;
                        if let Ok(lyric_resp) = direct.get(&lyric_url).send().await {
                            if lyric_resp.status().is_success() {
                                if let Ok(lyric_data) =
                                    lyric_resp.json::<NetEaseLyricResponse>().await
                                {
                                    synced_lyrics = lyric_data.lrc.and_then(|l| l.lyric);
                                }
                            }
                        }
                        return Some(LyricsRecord {
                            track_name: song.name,
                            artist_name,
                            album_name,
                            plain_lyrics: None,
                            synced_lyrics,
                        });
                    }
                }
            }
        }
        None
    };

    let artwork_request = async {
        let clients = [&direct, &sys_http];
        for client in clients {
            for country in ["HK", "US", "CN"] {
                if let Ok(response) = client
                    .get("https://itunes.apple.com/search")
                    .query(&[
                        ("term", query.as_str()),
                        ("entity", "song"),
                        ("limit", "1"),
                        ("country", country),
                    ])
                    .send()
                    .await
                {
                    if response.status().is_success() {
                        if let Ok(res) = response.json::<ItunesResponse>().await {
                            if let Some(track) = res.results.into_iter().next() {
                                if let Some(url) = track.artwork_url100 {
                                    return Some(url.replace("100x100", "600x600"));
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    };

    let (lyrics, artwork) = tokio::join!(lyrics_request, artwork_request);
    Ok(MusicMetadata {
        title: lyrics
            .as_ref()
            .map(|item| item.track_name.clone())
            .unwrap_or(query),
        artist: lyrics
            .as_ref()
            .map(|item| item.artist_name.clone())
            .unwrap_or_default(),
        album: lyrics
            .as_ref()
            .map(|item| item.album_name.clone())
            .unwrap_or_default(),
        artwork_url: artwork,
        lyrics: lyrics.as_ref().and_then(|item| item.plain_lyrics.clone()),
        synced_lyrics: lyrics.and_then(|item| item.synced_lyrics),
    })
}

fn http_direct() -> Result<reqwest::Client> {
    static DIRECT_HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = DIRECT_HTTP.get() {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .user_agent("Nimbus/0.2")
        .connect_timeout(std::time::Duration::from_secs(4))
        .timeout(std::time::Duration::from_secs(8))
        .build()?;
    let _ = DIRECT_HTTP.set(client.clone());
    Ok(client)
}

fn http() -> Result<reqwest::Client> {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = HTTP.get() {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .user_agent("Nimbus/0.2")
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let _ = HTTP.set(client.clone());
    Ok(client)
}
