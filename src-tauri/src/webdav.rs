use std::collections::{HashSet, VecDeque};

use percent_encoding::percent_decode_str;
use quick_xml::{events::Event, Reader};
use reqwest::{header::CONTENT_TYPE, Client, Method, StatusCode};
use url::Url;
use uuid::Uuid;

use crate::{
    error::{NimbusError, Result},
    model::{CloudEntry, MediaFile, ScanResult},
};

const PROPFIND_BODY: &str = r#"<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/><displayname/><getcontentlength/><getcontenttype/><getetag/></prop></propfind>"#;
const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "m4v", "mov", "avi", "webm", "ts", "m2ts", "flv", "wmv",
];
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "ape"];

#[derive(Default)]
struct DavEntryBuilder {
    href: String,
    display_name: String,
    size: u64,
    etag: Option<String>,
    content_type: Option<String>,
    is_directory: bool,
}

struct DavEntry {
    url: Url,
    display_name: String,
    size: u64,
    etag: Option<String>,
    content_type: Option<String>,
    is_directory: bool,
}

pub(crate) fn validated_url(endpoint: &str) -> Result<Url> {
    let mut url = Url::parse(endpoint)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(NimbusError::Validation(
            "WebDAV 地址必须是 HTTP 或 HTTPS".into(),
        ));
    }
    let is_local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !is_local {
        return Err(NimbusError::Validation(
            "WebDAV 必须使用 HTTPS；仅本机地址允许 HTTP".into(),
        ));
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

/// Text as people named it: URL paths are percent-encoded ("%E7%94%B5%E5%BD%B1" is "电影").
fn decoded(text: &str) -> String {
    percent_decode_str(text).decode_utf8_lossy().into_owned()
}

/// Where a URL sits below the account's address, decoded: "/电影/繁花" for
/// `https://dav.example.com/dav/%E7%94%B5%E5%BD%B1/%E7%B9%81%E8%8A%B1/` when the account is
/// `https://dav.example.com/dav/`, and "/" for the address itself. Files lists these paths and the
/// library stores them, so a file has one path wherever it is shown. `None` outside the account.
pub(crate) fn relative_path(base: &Url, url: &Url) -> Option<String> {
    if url.origin() != base.origin() {
        return None;
    }
    let mut path = decoded(url.path());
    if !path.ends_with('/') {
        path.push('/');
    }
    let rest = path.strip_prefix(decoded(base.path()).as_str())?;
    let segments: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    Some(format!("/{}", segments.join("/")))
}

/// The URL of a folder given by its path below the account's address.
fn folder_url(base: &Url, path: &str) -> Result<Url> {
    let outside = || NimbusError::Validation("目录不属于这个 WebDAV 来源".into());
    let mut url = base.clone();
    {
        let mut segments = url.path_segments_mut().map_err(|_| outside())?;
        segments.pop_if_empty();
        for segment in path.split('/').filter(|part| !part.is_empty()) {
            if matches!(segment, "." | "..") {
                return Err(outside());
            }
            // Encodes "%", "#", "?" and spaces, so any folder name round-trips.
            segments.push(segment);
        }
        segments.push("");
    }
    Ok(url)
}

/// The playable URL of a file that Files listed, and its path as a scan stores it, so playing it
/// from Files finds the library's copy instead of creating another.
pub(crate) fn file_location(endpoint: &str, entry_url: &str) -> Result<(String, String)> {
    let base = validated_url(endpoint)?;
    let outside = || NimbusError::Validation("文件不属于这个 WebDAV 来源".into());
    let url = Url::parse(entry_url).map_err(|_| outside())?;
    let path = relative_path(&base, &url)
        .filter(|path| path != "/")
        .ok_or_else(outside)?;
    Ok((url.to_string(), path))
}

/// A path saved by an older version (an encoded server path such as "/dav/%E7%94%B5%E5%BD%B1/",
/// or a file's URL) as a URL and the path below the account's address.
pub(crate) fn locate_saved(base: &Url, saved: &str) -> Option<(Url, String)> {
    let url = base.join(saved).ok()?;
    let path = relative_path(base, &url)?;
    Some((url, path))
}

fn client() -> Result<Client> {
    Ok(Client::builder()
        .user_agent("Nimbus/0.1")
        .connect_timeout(std::time::Duration::from_secs(12))
        .timeout(std::time::Duration::from_secs(45))
        .build()?)
}

async fn propfind(
    http: &Client,
    url: Url,
    depth: &str,
    username: &str,
    password: &str,
) -> Result<String> {
    let method = Method::from_bytes(b"PROPFIND").expect("valid WebDAV method");
    let response = http
        .request(method, url)
        .basic_auth(username, Some(password))
        .header("Depth", depth)
        .header(CONTENT_TYPE, "application/xml; charset=utf-8")
        .body(PROPFIND_BODY)
        .send()
        .await?;

    if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN {
        return Err(NimbusError::Validation(
            "认证失败，请检查用户名和密码".into(),
        ));
    }
    if response.status() != StatusCode::MULTI_STATUS && !response.status().is_success() {
        return Err(NimbusError::Validation(format!(
            "WebDAV 返回 HTTP {}",
            response.status()
        )));
    }
    Ok(response.text().await?)
}

fn parse_entries(xml: &str, request_url: &Url) -> Result<Vec<DavEntry>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut current: Option<DavEntryBuilder> = None;
    let mut field = String::new();
    let mut entries = Vec::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                let name =
                    String::from_utf8_lossy(event.local_name().as_ref()).to_ascii_lowercase();
                if name == "response" {
                    current = Some(DavEntryBuilder::default());
                } else {
                    if name == "collection" {
                        if let Some(entry) = current.as_mut() {
                            entry.is_directory = true;
                        }
                    }
                    field = name;
                }
            }
            Ok(Event::Empty(event)) => {
                if event
                    .local_name()
                    .as_ref()
                    .eq_ignore_ascii_case(b"collection")
                {
                    if let Some(entry) = current.as_mut() {
                        entry.is_directory = true;
                    }
                }
            }
            Ok(Event::Text(text)) => {
                if let Some(entry) = current.as_mut() {
                    let value = text
                        .unescape()
                        .map_err(|e| NimbusError::Internal(e.to_string()))?
                        .trim()
                        .to_string();
                    match field.as_str() {
                        "href" => entry.href.push_str(&value),
                        "displayname" => entry.display_name.push_str(&value),
                        "getcontentlength" => entry.size = value.parse().unwrap_or_default(),
                        "getetag" if !value.is_empty() => entry.etag = Some(value),
                        "getcontenttype" if !value.is_empty() => entry.content_type = Some(value),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(event)) => {
                let name =
                    String::from_utf8_lossy(event.local_name().as_ref()).to_ascii_lowercase();
                if name == "response" {
                    if let Some(entry) = current.take() {
                        if !entry.href.is_empty() {
                            let url = request_url.join(&entry.href)?;
                            if url.scheme() == request_url.scheme()
                                && url.host_str() == request_url.host_str()
                                && url.port_or_known_default()
                                    == request_url.port_or_known_default()
                            {
                                let fallback_name = url
                                    .path_segments()
                                    .and_then(|segments| {
                                        segments.filter(|part| !part.is_empty()).next_back()
                                    })
                                    .map(decoded)
                                    .unwrap_or_else(|| "未命名".to_string());
                                entries.push(DavEntry {
                                    url,
                                    display_name: if entry.display_name.is_empty() {
                                        fallback_name
                                    } else {
                                        entry.display_name
                                    },
                                    size: entry.size,
                                    etag: entry.etag,
                                    content_type: entry.content_type,
                                    is_directory: entry.is_directory,
                                });
                            }
                        }
                    }
                }
                field.clear();
            }
            Ok(Event::Eof) => break,
            Err(error) => {
                return Err(NimbusError::Internal(format!(
                    "WebDAV XML 无法解析：{error}"
                )))
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(entries)
}

fn is_video(url: &Url) -> bool {
    url.path().rsplit_once('.').is_some_and(|(_, extension)| {
        VIDEO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
    })
}

pub async fn validate_connection(endpoint: &str, username: &str, password: &str) -> Result<()> {
    let url = validated_url(endpoint)?;
    propfind(&client()?, url, "0", username, password).await?;
    Ok(())
}

/// Scan the folder at `root`, a path below the account's address as Files shows it.
pub async fn scan(
    account_id: &str,
    endpoint: &str,
    root: &str,
    username: &str,
    password: &str,
    max_depth: usize,
    max_entries: usize,
    kind: &str,
) -> Result<(Vec<MediaFile>, ScanResult)> {
    let base = validated_url(endpoint)?;
    let http = client()?;
    let mut queue = VecDeque::from([(folder_url(&base, root)?, 0_usize)]);
    let mut visited = HashSet::new();
    let mut files = Vec::new();
    let mut discovered_files = 0_usize;
    let mut truncated = false;

    while let Some((directory, depth)) = queue.pop_front() {
        // Decoded paths, so a folder the server spells with other escapes is still one folder.
        let Some(directory_key) = relative_path(&base, &directory) else {
            continue;
        };
        if !visited.insert(directory_key.clone()) {
            continue;
        }
        let xml = propfind(&http, directory.clone(), "1", username, password).await?;
        for entry in parse_entries(&xml, &directory)? {
            let Some(path) = relative_path(&base, &entry.url) else {
                continue;
            };
            if path == directory_key {
                continue;
            }
            if visited.len() + discovered_files >= max_entries {
                truncated = true;
                break;
            }
            if entry.is_directory {
                if depth < max_depth {
                    queue.push_back((entry.url, depth + 1));
                } else {
                    truncated = true;
                }
            } else {
                discovered_files += 1;
                if is_video(&entry.url) && kind == "movie"
                    || kind == "music"
                        && entry.url.path().rsplit_once('.').is_some_and(|(_, ext)| {
                            AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
                        })
                    || kind == "document" && crate::media_types::is_document(entry.url.path())
                {
                    files.push(MediaFile {
                        id: Uuid::new_v4().to_string(),
                        account_id: account_id.to_string(),
                        remote_path: entry.url.to_string(),
                        cloud_path: Some(path),
                        display_name: entry.display_name,
                        size: entry.size,
                        etag: entry.etag,
                        mime_type: entry.content_type,
                        source_id: None,
                        source_ids: Vec::new(),
                        media_kind: None,
                    });
                }
            }
        }
        if truncated {
            break;
        }
    }

    let result = ScanResult {
        visited_directories: visited.len(),
        discovered_files,
        media_files: files.len(),
        truncated,
    };
    Ok((files, result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multistatus() {
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
          <d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
          <d:response><d:href>/dav/Movies/</d:href><d:propstat><d:prop><d:displayname>Movies</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
          <d:response><d:href>/dav/Movie.mkv</d:href><d:propstat><d:prop><d:displayname>Movie.mkv</d:displayname><d:getcontentlength>1024</d:getcontentlength><d:getetag>abc</d:getetag></d:prop></d:propstat></d:response>
        </d:multistatus>"#;
        let request = Url::parse("https://dav.example.com/dav/").unwrap();
        let entries = parse_entries(xml, &request).unwrap();
        assert_eq!(entries.len(), 3);
        assert!(entries[1].is_directory);
        assert_eq!(entries[2].display_name, "Movie.mkv");
        assert_eq!(entries[2].size, 1024);
        assert!(is_video(&entries[2].url));
    }
}

// Return all immediate children; callers choose a specific root before scanning.
// `path` is below the account's address ("/" is the address itself); each entry's id is its URL.
pub async fn browse(
    endpoint: &str,
    path: &str,
    username: &str,
    password: &str,
) -> Result<Vec<CloudEntry>> {
    let base = validated_url(endpoint)?;
    let target = folder_url(&base, path)?;
    let current = relative_path(&base, &target);
    let xml = propfind(&client()?, target.clone(), "1", username, password).await?;
    Ok(parse_entries(&xml, &target)?
        .into_iter()
        .filter_map(|entry| {
            let path = relative_path(&base, &entry.url)?;
            (Some(&path) != current.as_ref()).then(|| CloudEntry {
                id: entry.url.to_string(),
                path,
                name: entry.display_name,
                is_dir: entry.is_directory,
                size: entry.size,
                modified_at: None,
            })
        })
        .collect())
}

#[cfg(test)]
mod regression_tests {
    use super::*;
    #[test]
    fn unescapes_display_names_and_recognizes_explicit_collection() {
        let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/A/</d:href><d:propstat><d:prop><d:displayname>A &amp; B</d:displayname><d:resourcetype><d:collection></d:collection></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>"#;
        let entries = parse_entries(xml, &Url::parse("https://example.com/dav/").unwrap()).unwrap();
        assert_eq!(entries[0].display_name, "A & B");
        assert!(entries[0].is_directory);
    }
    #[test]
    fn rejects_cross_origin_hrefs() {
        let xml = r#"<multistatus><response><href>https://other.example/a.mkv</href></response></multistatus>"#;
        assert!(
            parse_entries(xml, &Url::parse("https://example.com/").unwrap())
                .unwrap()
                .is_empty()
        );
    }
}

#[cfg(test)]
mod path_tests {
    use super::*;
    use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const HREF: &AsciiSet = &NON_ALPHANUMERIC.remove(b'/').remove(b'.').remove(b'-');

    #[test]
    fn paths_are_decoded_and_relative_to_the_account_address() {
        let base = validated_url("https://cloud.example.com/remote.php/dav/files/me").unwrap();
        let url = |path: &str| Url::parse(&format!("https://cloud.example.com{path}")).unwrap();
        let relative = |path: &str| relative_path(&base, &url(path));
        assert_eq!(relative("/remote.php/dav/files/me/").as_deref(), Some("/"));
        assert_eq!(relative("/remote.php/dav/files/me").as_deref(), Some("/"));
        assert_eq!(
            relative("/remote.php/dav/files/me/%E7%94%B5%E5%BD%B1/").as_deref(),
            Some("/电影")
        );
        // Escapes spelled differently are the same folder.
        assert_eq!(
            relative("/remote.php/dav/files/me/%e7%94%b5%e5%bd%b1/A%20B.mkv").as_deref(),
            Some("/电影/A B.mkv")
        );
        assert_eq!(relative("/remote.php/dav/files/"), None);
        assert_eq!(relative("/remote.php/dav/files/meme/a.mkv"), None);
        let other = Url::parse("https://other.example.com/remote.php/dav/files/me/a").unwrap();
        assert_eq!(relative_path(&base, &other), None);
    }

    #[test]
    fn folder_urls_round_trip_any_name_and_stay_inside_the_account() {
        let base = validated_url("https://dav.jianguoyun.com/dav/").unwrap();
        assert_eq!(folder_url(&base, "/").unwrap().path(), "/dav/");
        for path in ["/电影/繁花 第二季", "/100% #1?", "/a/b/c"] {
            let url = folder_url(&base, path).unwrap();
            assert!(url.path().starts_with("/dav/") && url.path().ends_with('/'));
            assert_eq!(url.query(), None);
            assert_eq!(url.fragment(), None);
            assert_eq!(relative_path(&base, &url).as_deref(), Some(path));
        }
        assert!(folder_url(&base, "/../etc").is_err());
    }

    #[test]
    fn files_played_from_files_get_their_url_and_library_path() {
        let endpoint = "https://nas.example.com/dav";
        let (url, path) =
            file_location(endpoint, "https://nas.example.com/dav/%E7%94%B5%E5%BD%B1/a.mkv").unwrap();
        assert_eq!(url, "https://nas.example.com/dav/%E7%94%B5%E5%BD%B1/a.mkv");
        assert_eq!(path, "/电影/a.mkv");
        assert!(file_location(endpoint, "/dav/%E7%94%B5%E5%BD%B1/a.mkv").is_err());
        assert!(file_location(endpoint, "https://evil.example.com/dav/a.mkv").is_err());
        assert!(file_location(endpoint, "https://nas.example.com/other/a.mkv").is_err());
    }

    #[test]
    fn saved_server_paths_and_urls_are_located() {
        let base = validated_url("https://nas.example.com/dav").unwrap();
        let (url, path) = locate_saved(&base, "/dav/%E7%94%B5%E5%BD%B1/").unwrap();
        assert_eq!(url.as_str(), "https://nas.example.com/dav/%E7%94%B5%E5%BD%B1/");
        assert_eq!(path, "/电影");
        let (url, path) = locate_saved(&base, "https://nas.example.com/dav/M/a%20b.mkv").unwrap();
        assert_eq!(url.as_str(), "https://nas.example.com/dav/M/a%20b.mkv");
        assert_eq!(path, "/M/a b.mkv");
        assert!(locate_saved(&base, "https://other.example.com/dav/a.mkv").is_none());
    }

    #[test]
    fn names_without_displayname_are_decoded() {
        let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/%E7%B9%81%E8%8A%B1%20%E7%AC%AC01%E9%9B%86.mkv</d:href></d:response></d:multistatus>"#;
        let entries = parse_entries(xml, &Url::parse("https://example.com/dav/").unwrap()).unwrap();
        assert_eq!(entries[0].display_name, "繁花 第01集.mkv");
    }

    /// A Nextcloud-style server below `/remote.php/dav/files/me/` that leaves out displayname and
    /// spells one folder's own href with lowercase escapes.
    async fn serve(listener: tokio::net::TcpListener) {
        let response = |href: &str, directory: bool| {
            format!(
                "<d:response><d:href>{href}</d:href><d:propstat><d:prop>{}<d:getcontentlength>10</d:getcontentlength></d:prop></d:propstat></d:response>",
                if directory { "<d:resourcetype><d:collection/></d:resourcetype>" } else { "<d:resourcetype/>" }
            )
        };
        let href = |path: &str| utf8_percent_encode(path, HREF).to_string();
        let root = "/remote.php/dav/files/me/";
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = socket.read(&mut buffer).await.unwrap_or(0);
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request).to_string();
                if read == 0 {
                    break;
                }
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let text = String::from_utf8_lossy(&request).to_string();
            let target = text.split_whitespace().nth(1).unwrap_or("/").to_owned();
            let path = decoded(&target);
            let entries = if path == root {
                vec![
                    response(&href(root), true),
                    response(&href(&format!("{root}电影/")), true),
                    response(&href(&format!("{root}Notes.txt")), false),
                ]
            } else if path == format!("{root}电影/") {
                vec![
                    response(&href(&path), true),
                    response(&href(&format!("{path}繁花 第二季/")), true),
                    response(&href(&format!("{path}100% #1?.mkv")), false),
                ]
            } else if path == format!("{root}电影/繁花 第二季/") {
                vec![
                    response(&href(&path).to_lowercase(), true),
                    response(&href(&format!("{path}繁花 第01集.mkv")), false),
                    response(&href(&format!("{path}繁花 第02集.mkv")), false),
                ]
            } else {
                Vec::new()
            };
            let (status, body) = if entries.is_empty() {
                ("404 Not Found", String::new())
            } else {
                (
                    "207 Multi-Status",
                    format!(r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">{}</d:multistatus>"#, entries.join("")),
                )
            };
            let reply = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn files_and_scans_agree_on_paths_below_a_sub_path_endpoint() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://127.0.0.1:{}/remote.php/dav/files/me",
            listener.local_addr().unwrap().port()
        );
        tokio::spawn(serve(listener));

        let root = browse(&endpoint, "/", "u", "p").await.unwrap();
        let listed: Vec<_> = root.iter().map(|entry| (entry.path.as_str(), entry.name.as_str())).collect();
        assert_eq!(listed, [("/电影", "电影"), ("/Notes.txt", "Notes.txt")]);

        let movies = browse(&endpoint, &root[0].path, "u", "p").await.unwrap();
        let listed: Vec<_> = movies.iter().map(|entry| (entry.path.as_str(), entry.name.as_str())).collect();
        assert_eq!(
            listed,
            [("/电影/繁花 第二季", "繁花 第二季"), ("/电影/100% #1?.mkv", "100% #1?.mkv")]
        );
        // The folder's own entry is left out even when the server spells it differently.
        let season = browse(&endpoint, &movies[0].path, "u", "p").await.unwrap();
        assert_eq!(season.len(), 2);

        let (files, result) = scan("acc", &endpoint, "/电影", "u", "p", 8, 100, "movie")
            .await
            .unwrap();
        assert_eq!(result.media_files, 3);
        let scanned: std::collections::HashMap<_, _> = files
            .iter()
            .map(|file| (file.cloud_path.clone().unwrap(), file.remote_path.clone()))
            .collect();
        assert!(scanned.contains_key("/电影/繁花 第二季/繁花 第01集.mkv"));
        assert!(scanned.values().all(|url| url.starts_with(&format!("{endpoint}/"))));
        // Playing from Files resolves to exactly what the scan stored.
        for entry in season.iter().chain(&movies[1..]) {
            let (url, path) = file_location(&endpoint, &entry.id).unwrap();
            assert_eq!(path, entry.path);
            assert_eq!(scanned.get(&path), Some(&url));
        }
    }
}
