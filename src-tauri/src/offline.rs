//! Videos kept on this Mac for watching without streaming. Downloads run one at a time through the
//! stream proxy (which knows every cloud provider), resume after a dropped connection, and report
//! "offline-progress" events. A finished copy is what playback opens.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{LazyLock, OnceLock},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::{
    error::{NimbusError, Result},
    model::MediaFile,
    AppState,
};

static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static QUEUE: LazyLock<parking_lot::Mutex<VecDeque<String>>> = LazyLock::new(Default::default);
static ACTIVE: LazyLock<parking_lot::Mutex<HashMap<String, Progress>>> = LazyLock::new(Default::default);
static CANCELLED: LazyLock<parking_lot::Mutex<HashSet<String>>> = LazyLock::new(Default::default);
static WAKE: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);
const ATTEMPTS: usize = 4;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub file_id: String,
    /// "queued", "downloading", "done", "failed" or "cancelled".
    pub state: String,
    pub received: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub fn init(data_dir: &Path) {
    let _ = DIRECTORY.set(data_dir.join("Offline"));
}

fn directory() -> Result<&'static PathBuf> {
    DIRECTORY.get().ok_or_else(|| NimbusError::Internal("离线目录尚未初始化".into()))
}

/// Only ids made by the library (uuids) name files here, so nothing can point outside the folder.
fn valid_id(file_id: &str) -> bool {
    !file_id.is_empty() && file_id.len() <= 64 && file_id.chars().all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn extension_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .filter(|extension| extension.len() <= 5 && extension.chars().all(|character| character.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "video".into())
}

fn final_path(file: &MediaFile) -> Result<PathBuf> {
    if !valid_id(&file.id) {
        return Err(NimbusError::Validation("文件标识无效".into()));
    }
    Ok(directory()?.join(format!("{}.{}", file.id, extension_of(&file.display_name))))
}

fn partial_path(file_id: &str) -> Result<PathBuf> {
    Ok(directory()?.join(format!(".{file_id}.part")))
}

/// The downloaded copy of a file, when there is a complete one.
pub fn local_copy(file: &MediaFile) -> Option<PathBuf> {
    let path = final_path(file).ok()?;
    path.is_file().then_some(path)
}

fn emit(app: &AppHandle, progress: &Progress) {
    let _ = app.emit("offline-progress", progress);
}

/// Queue files for download; ones already downloaded, queued or not from a cloud are skipped.
pub fn enqueue(app: &AppHandle, files: Vec<MediaFile>) -> usize {
    let mut queued = 0;
    for file in files {
        if local_copy(&file).is_some() || QUEUE.lock().contains(&file.id) || ACTIVE.lock().contains_key(&file.id) {
            continue;
        }
        CANCELLED.lock().remove(&file.id);
        QUEUE.lock().push_back(file.id.clone());
        let progress = Progress { file_id: file.id.clone(), state: "queued".into(), received: 0, total: file.size, message: None };
        ACTIVE.lock().insert(file.id.clone(), progress.clone());
        emit(app, &progress);
        queued += 1;
    }
    WAKE.notify_one();
    queued
}

/// Stop downloading (or waiting to download) these files and drop what was fetched.
pub fn cancel(app: &AppHandle, file_ids: &[String]) {
    for id in file_ids {
        QUEUE.lock().retain(|queued| queued != id);
        CANCELLED.lock().insert(id.clone());
        if ACTIVE.lock().remove(id).is_some() {
            emit(app, &Progress { file_id: id.clone(), state: "cancelled".into(), received: 0, total: 0, message: None });
        }
        if let Ok(path) = partial_path(id) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Delete downloaded copies.
pub fn remove(app: &AppHandle, files: &[MediaFile]) {
    for file in files {
        if let Ok(path) = final_path(file) {
            let _ = std::fs::remove_file(path);
        }
        emit(app, &Progress { file_id: file.id.clone(), state: "cancelled".into(), received: 0, total: 0, message: None });
    }
}

/// What is downloaded, downloading or waiting.
pub fn list(state: &AppState) -> Vec<Progress> {
    let mut items: Vec<Progress> = ACTIVE.lock().values().cloned().collect();
    let Ok(entries) = directory().and_then(|directory| Ok(std::fs::read_dir(directory)?)) else {
        return items;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Some((id, _)) = name.split_once('.') else { continue };
        if items.iter().any(|item| item.file_id == id) || state.store.get_media_file(id).is_err() {
            continue;
        }
        let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        items.push(Progress { file_id: id.to_owned(), state: "done".into(), received: size, total: size, message: None });
    }
    items
}

/// The download worker: one file at a time, for as long as the app runs.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let next = QUEUE.lock().pop_front();
            let Some(file_id) = next else {
                WAKE.notified().await;
                continue;
            };
            let result = download(&app, &file_id).await;
            let cancelled = CANCELLED.lock().remove(&file_id);
            let finished = ACTIVE.lock().remove(&file_id);
            if cancelled {
                continue;
            }
            let total = finished.as_ref().map_or(0, |progress| progress.total);
            let progress = match result {
                Ok(size) => Progress { file_id, state: "done".into(), received: size, total: size, message: None },
                Err(error) => Progress { file_id, state: "failed".into(), received: 0, total, message: Some(error.to_string()) },
            };
            emit(&app, &progress);
        }
    });
}

async fn download(app: &AppHandle, file_id: &str) -> Result<u64> {
    let state = app.state::<AppState>();
    let file = state.store.get_media_file(file_id)?;
    let target = final_path(&file)?;
    let partial = partial_path(file_id)?;
    tokio::fs::create_dir_all(target.parent().unwrap_or(Path::new("/"))).await?;
    let (url, token) = state.proxy.create_download_url(file_id.to_owned()).await;
    let report = |progress: Progress| {
        ACTIVE.lock().insert(progress.file_id.clone(), progress.clone());
        emit(app, &progress);
    };
    let result = fetch(&file, &url, &partial, report).await;
    state.proxy.release(&token).await;
    let size = result?;
    tokio::fs::rename(&partial, &target).await?;
    Ok(size)
}

/// Fetch into `partial`, continuing from what it holds; a dropped connection resumes a few times.
async fn fetch(file: &MediaFile, url: &str, partial: &Path, report: impl Fn(Progress)) -> Result<u64> {
    let client = crate::http_client::direct_transfer_http();
    let mut last_error = None;
    for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
        }
        let mut received = tokio::fs::metadata(partial).await.map(|metadata| metadata.len()).unwrap_or(0);
        let mut request = client.get(url);
        if received > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={received}-"));
        }
        let mut response = match request.send().await.and_then(|response| response.error_for_status()) {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(NimbusError::from(error));
                continue;
            }
        };
        // A server that ignores the range sends the whole file again.
        let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if !resumed {
            received = 0;
        }
        let total = response.content_length().map_or(file.size, |length| length + received).max(file.size);
        let mut output = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(partial)
            .await?;
        let mut reported = Instant::now();
        let outcome: Result<()> = async {
            while let Some(chunk) = response.chunk().await? {
                if CANCELLED.lock().contains(&file.id) {
                    return Err(NimbusError::Validation("已取消".into()));
                }
                output.write_all(&chunk).await?;
                received += chunk.len() as u64;
                if reported.elapsed() >= Duration::from_millis(500) {
                    reported = Instant::now();
                    report(Progress { file_id: file.id.clone(), state: "downloading".into(), received, total, message: None });
                }
            }
            output.flush().await?;
            Ok(())
        }
        .await;
        match outcome {
            Ok(()) if total == 0 || received >= total => return Ok(received),
            Ok(()) => last_error = Some(NimbusError::Validation("下载提前结束".into())),
            Err(error) if CANCELLED.lock().contains(&file.id) => return Err(error),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| NimbusError::Validation("下载失败".into())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(id: &str, size: u64) -> MediaFile {
        MediaFile {
            id: id.into(),
            account_id: "cloud".into(),
            remote_path: "/a.mkv".into(),
            cloud_path: None,
            display_name: "a.mkv".into(),
            size,
            etag: None,
            mime_type: None,
            source_id: None,
            source_ids: Vec::new(),
            media_kind: Some("movie".into()),
        }
    }

    /// A server that honours "Range: bytes=N-", like the stream proxy.
    async fn serve(content: &'static [u8]) -> String {
        use axum::{http::{HeaderMap, StatusCode}, routing::get, Router};
        let router = Router::new().route(
            "/file",
            get(move |headers: HeaderMap| async move {
                let start = headers
                    .get("range")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.strip_prefix("bytes="))
                    .and_then(|value| value.trim_end_matches('-').parse::<usize>().ok());
                match start {
                    Some(start) => (StatusCode::PARTIAL_CONTENT, content[start..].to_vec()),
                    None => (StatusCode::OK, content.to_vec()),
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        format!("http://{address}/file")
    }

    #[tokio::test]
    async fn downloads_whole_files_and_resumes_a_partial_one() {
        static CONTENT: LazyLock<Vec<u8>> = LazyLock::new(|| (0..3_000_000u32).map(|value| (value % 251) as u8).collect());
        let url = serve(CONTENT.as_slice()).await;
        let directory = std::env::temp_dir().join(format!("cove-offline-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();

        let fresh = directory.join(".fresh.part");
        let size = fetch(&file("fresh", CONTENT.len() as u64), &url, &fresh, |_| ()).await.unwrap();
        assert_eq!(size, CONTENT.len() as u64);
        assert_eq!(std::fs::read(&fresh).unwrap(), *CONTENT);

        // Half was fetched before the connection dropped: only the rest is requested.
        let resumed = directory.join(".resumed.part");
        std::fs::write(&resumed, &CONTENT[..1_234_567]).unwrap();
        let size = fetch(&file("resumed", CONTENT.len() as u64), &url, &resumed, |_| ()).await.unwrap();
        assert_eq!(size, CONTENT.len() as u64);
        assert_eq!(std::fs::read(&resumed).unwrap(), *CONTENT);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn copies_are_named_by_library_id_only() {
        assert!(valid_id("0f3c2a9e-1d2b-4c5d-8e9f-001122334455"));
        assert!(!valid_id("../etc"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id(""));
        assert_eq!(extension_of("剧.S01E01.MKV"), "mkv");
        assert_eq!(extension_of("no-extension"), "video");
        assert_eq!(extension_of("weird.ex/t"), "video");
    }
}
