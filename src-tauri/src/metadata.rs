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
    /// The name this result was looked up with. When the library groups a work differently and the
    /// name changes, the cached result no longer applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
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

/// A year word, or a year glued to a title ("基督山伯爵2024"): the title part and the year.
fn year_in(word: &str) -> Option<(&str, &str)> {
    let is_year = |value: &str| {
        value.len() == 4
            && value.chars().all(|value| value.is_ascii_digit())
            && (value.starts_with("19") || value.starts_with("20"))
    };
    if is_year(word) {
        return Some(("", word));
    }
    let character_starts = word
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if character_starts.len() > 4 {
        let split = character_starts[character_starts.len() - 4];
        if is_year(&word[split..]) {
            return Some((
                word[..split].trim_end_matches(['-', ' ', '.']),
                &word[split..],
            ));
        }
    }
    None
}

/// Drops a copy number such as the "(1)" in "《驯鹿宝贝》(1)"; a sequel number stays.
fn without_copy_numbers(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(['(', '（']) {
        let open = rest[start..].chars().next().map_or(1, char::len_utf8);
        let inside = &rest[start + open..];
        let digits = inside.bytes().take_while(u8::is_ascii_digit).count();
        let close = inside[digits..]
            .chars()
            .next()
            .filter(|value| matches!(value, ')' | '）'));
        result.push_str(&rest[..start]);
        match close {
            Some(close) if (1..=2).contains(&digits) => {
                result.push(' ');
                rest = &inside[digits + close.len_utf8()..];
            }
            _ => {
                result.push_str(&rest[start..start + open]);
                rest = inside;
            }
        }
    }
    result.push_str(rest);
    result
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
    let mut normalized = without_copy_numbers(stem).replace(
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
    let parts = normalized.split_whitespace().collect::<Vec<_>>();
    // Only the last year is the release year: "Blade Runner 2049 2017", "1917 2019". A name that is
    // only a year ("2046") is a title.
    let release = parts
        .iter()
        .rposition(|word| year_in(word).is_some())
        .filter(|index| {
            *index > 0 || year_in(parts[0]).is_some_and(|(title, _)| !title.is_empty())
        });
    for (index, word) in parts.iter().copied().enumerate() {
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
        if Some(index) == release {
            if let Some((title, found)) = year_in(word) {
                if !title.is_empty() {
                    words.push(title);
                }
                year = Some(found.to_owned());
            }
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
        // "01" is an episode number; "Toy Story 3" and "12 Monkeys" keep theirs.
        if lower.len() <= 2
            && lower.starts_with('0')
            && lower.chars().all(|value| value.is_ascii_digit())
        {
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
    use super::{best_result, movie_query, MovieMetadata, TmdbSearchResult};

    fn result(media_type: &str, title: &str, date: &str) -> TmdbSearchResult {
        serde_json::from_value(serde_json::json!({
            "id": 1, "media_type": media_type,
            "title": if media_type == "movie" { Some(title) } else { None },
            "name": if media_type == "tv" { Some(title) } else { None },
            "release_date": if media_type == "movie" { Some(date) } else { None },
            "first_air_date": if media_type == "tv" { Some(date) } else { None },
        }))
        .unwrap()
    }

    #[test]
    fn search_prefers_the_year_then_the_kind_the_library_found() {
        let pocahontas = [result("movie", "风中奇缘", "1995-06-10"), result("tv", "风中奇缘", "2014-10-22")];
        assert_eq!(best_result(&pocahontas, "风中奇缘", None, Some("tv")), 1);
        assert_eq!(best_result(&pocahontas, "风中奇缘", None, Some("movie")), 0);
        let monte_cristo = [result("movie", "基督山伯爵", "2024-06-28"), result("tv", "基督山伯爵", "2025-01-13")];
        assert_eq!(best_result(&monte_cristo, "基督山伯爵", Some("2024"), Some("tv")), 1);
        let iron_man = [result("movie", "钢铁侠", "2008-04-30"), result("movie", "钢铁侠2", "2010-04-28")];
        assert_eq!(best_result(&iron_man, "Iron Man", Some("2010"), Some("movie")), 1);
        assert_eq!(best_result(&iron_man, "钢铁侠", None, None), 0);
    }

    #[test]
    fn cached_details_remember_their_lookup_name() {
        let old: MovieMetadata = serde_json::from_str(
            r#"{"tmdbId":1,"mediaType":"tv","title":"大明王朝1566","originalTitle":"","year":2007,"overview":"","rating":9.7,"posterUrl":null}"#,
        )
        .unwrap();
        assert_eq!(old.query, None);
        let mut current = old.clone();
        current.query = Some("大明王朝1566".into());
        let json = serde_json::to_string(&current).unwrap();
        assert!(json.contains(r#""query":"大明王朝1566""#));
        assert!(!serde_json::to_string(&old).unwrap().contains("query"));
    }

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

    #[test]
    fn sequel_numbers_and_years_in_titles_stay_in_the_query() {
        let query = |name: &str, title: &str, year: Option<&str>| {
            assert_eq!(
                movie_query(name),
                (title.to_owned(), year.map(str::to_owned)),
                "{name}"
            );
        };
        query("Blade Runner 2049 2017", "Blade Runner 2049", Some("2017"));
        query("Wonder Woman 1984 2020", "Wonder Woman 1984", Some("2020"));
        query("1917 2019", "1917", Some("2019"));
        query("2046", "2046", None);
        query("银翼杀手2049 2017", "银翼杀手2049", Some("2017"));
        query("Toy Story 3", "Toy Story 3", None);
        query("Iron Man 2", "Iron Man 2", None);
        query("12 Monkeys 1995", "12 Monkeys", Some("1995"));
        query("2 Fast 2 Furious 2003", "2 Fast 2 Furious", Some("2003"));
        query("基督山伯爵2024", "基督山伯爵", Some("2024"));
        query("示例剧 01", "示例剧", None);
    }
}

/// Cached film and series details. Bump when lookups change so earlier results are fetched again.
pub const MOVIE_CACHE: &str = "movie-v7";

/// Pick the search result to use. The kind of work the library found counts most (a 35-episode
/// "风中奇缘" is the 2014 series, not the 1995 film; a series' first air date can be a year after the
/// one in its folder name), then a matching year, then an exact title. Ties keep TMDB's own order.
fn best_result(results: &[TmdbSearchResult], query: &str, year: Option<&str>, kind: Option<&str>) -> usize {
    let expected = query.to_lowercase();
    let score = |item: &TmdbSearchResult| {
        let date = item.release_date.as_deref().or(item.first_air_date.as_deref());
        let year_matches = year.is_some_and(|year| date.is_some_and(|date| date.starts_with(year)));
        let kind_matches = kind.is_some_and(|kind| item.media_type == kind);
        let title_matches = [&item.title, &item.name, &item.original_title, &item.original_name]
            .into_iter()
            .flatten()
            .any(|title| title.to_lowercase() == expected);
        u8::from(kind_matches) * 4 + u8::from(year_matches) * 2 + u8::from(title_matches)
    };
    let mut best = 0;
    for (index, item) in results.iter().enumerate() {
        if score(item) > score(&results[best]) {
            best = index;
        }
    }
    best
}

/// Look up a film or series. `kind` is "movie" or "tv" when the library already knows which it is.
pub async fn movie(name: &str, kind: Option<&str>) -> Result<MovieMetadata> {
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
    let preferred = best_result(&results, &query, year.as_deref(), kind);
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
        query: None,
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
