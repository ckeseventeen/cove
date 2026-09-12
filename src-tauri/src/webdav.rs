use std::collections::{HashSet, VecDeque};

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

fn validated_url(endpoint: &str) -> Result<Url> {
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
                                    .unwrap_or("未命名")
                                    .to_string();
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

fn normalized_path(url: &Url) -> &str {
    url.path().trim_end_matches('/')
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

pub async fn scan(
    account_id: &str,
    endpoint: &str,
    username: &str,
    password: &str,
    max_depth: usize,
    max_entries: usize,
    kind: &str,
) -> Result<(Vec<MediaFile>, ScanResult)> {
    let root = validated_url(endpoint)?;
    let http = client()?;
    let mut queue = VecDeque::from([(root, 0_usize)]);
    let mut visited = HashSet::new();
    let mut files = Vec::new();
    let mut discovered_files = 0_usize;
    let mut truncated = false;

    while let Some((directory, depth)) = queue.pop_front() {
        let directory_key = normalized_path(&directory).to_string();
        if !visited.insert(directory_key.clone()) {
            continue;
        }
        let xml = propfind(&http, directory.clone(), "1", username, password).await?;
        for entry in parse_entries(&xml, &directory)? {
            if normalized_path(&entry.url) == directory_key {
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
                {
                    files.push(MediaFile {
                        id: Uuid::new_v4().to_string(),
                        account_id: account_id.to_string(),
                        remote_path: entry.url.to_string(),
                        cloud_path: Some(entry.url.path().to_owned()),
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
pub async fn browse(
    endpoint: &str,
    path: &str,
    username: &str,
    password: &str,
) -> Result<Vec<CloudEntry>> {
    let base = validated_url(endpoint)?;
    let target = if path == "/" {
        base.clone()
    } else {
        base.join(path)?
    };
    if target.origin() != base.origin() || !target.path().starts_with(base.path()) {
        return Err(NimbusError::Validation("目录不属于这个 WebDAV 来源".into()));
    }
    let xml = propfind(&client()?, target.clone(), "1", username, password).await?;
    Ok(parse_entries(&xml, &target)?
        .into_iter()
        .filter(|entry| normalized_path(&entry.url) != normalized_path(&target))
        .map(|entry| CloudEntry {
            id: entry.url.to_string(),
            path: entry.url.path().to_owned(),
            name: entry.display_name,
            is_dir: entry.is_directory,
            size: entry.size,
            modified_at: None,
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
