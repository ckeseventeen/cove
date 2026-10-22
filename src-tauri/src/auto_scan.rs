//! Keeping media folders current without the 重新扫描 button. Cloud folders are rescanned once their
//! last scan is a few hours old; local folders every half hour and, through FSEvents, a few seconds
//! after files change in them. Every scan, manual or not, reports itself as a `source-scan` event so
//! the window can show it and refresh.
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::LazyLock,
    time::Duration,
};

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    error::{NimbusError, Result},
    model::{MediaSource, ScanResult},
    AppState,
};

const CLOUD_INTERVAL: i64 = 6 * 60 * 60;
const LOCAL_INTERVAL: i64 = 30 * 60;
/// After a failed background scan (signed out, offline), wait this long before trying that folder again.
const RETRY_AFTER: i64 = 60 * 60;
const STARTUP_DELAY: Duration = Duration::from_secs(30);
const TICK: Duration = Duration::from_secs(10 * 60);
/// File changes settle (a copy in progress, a batch of renames) before a local folder is rescanned.
const SETTLE: Duration = Duration::from_secs(5);

static SCANNING: LazyLock<parking_lot::Mutex<HashSet<String>>> = LazyLock::new(Default::default);
static FAILED_AT: LazyLock<parking_lot::Mutex<HashMap<String, i64>>> = LazyLock::new(Default::default);
static WATCHER: LazyLock<parking_lot::Mutex<Option<notify::RecommendedWatcher>>> = LazyLock::new(Default::default);
static WATCHED: LazyLock<parking_lot::Mutex<Vec<(PathBuf, String)>>> = LazyLock::new(Default::default);
static CHANGED: LazyLock<parking_lot::Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>> =
    LazyLock::new(Default::default);

/// Held while a source scans, so a background scan never runs over a manual one.
struct ScanGuard(String);

impl ScanGuard {
    fn acquire(source_id: &str) -> Option<Self> {
        SCANNING.lock().insert(source_id.to_owned()).then(|| Self(source_id.to_owned()))
    }
}

impl Drop for ScanGuard {
    fn drop(&mut self) {
        SCANNING.lock().remove(&self.0);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanEvent<'a> {
    source_id: &'a str,
    /// "started", "finished" or "failed".
    phase: &'a str,
    background: bool,
    added: usize,
    removed: usize,
    message: Option<String>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

/// Whether a source should be rescanned in the background now.
pub fn is_due(source: &MediaSource, provider: &str, now: i64, failed_at: Option<i64>) -> bool {
    if source.remote_root == "/" {
        return false;
    }
    if failed_at.is_some_and(|failed| now - failed < RETRY_AFTER) {
        return false;
    }
    // A share on the local network is as cheap to read as a local disk.
    let interval = if matches!(provider, "local" | "smb") { LOCAL_INTERVAL } else { CLOUD_INTERVAL };
    source.last_scan_at.map_or(true, |last| now - last >= interval)
}

/// Scan one source and report it. A second scan of the same source while one runs is refused.
pub(crate) async fn scan(app: &AppHandle, source_id: &str, background: bool) -> Result<ScanResult> {
    let Some(_guard) = ScanGuard::acquire(source_id) else {
        return Err(NimbusError::Validation("这个文件夹正在更新，请稍候".into()));
    };
    let state = app.state::<AppState>();
    let emit = |phase: &str, added: usize, removed: usize, message: Option<String>| {
        let _ = app.emit(
            "source-scan",
            ScanEvent { source_id, phase, background, added, removed, message },
        );
    };
    emit("started", 0, 0, None);
    let before = state.store.source_file_paths(source_id).unwrap_or_default();
    match crate::commands::library::scan_source(&state, source_id).await {
        Ok(result) => {
            FAILED_AT.lock().remove(source_id);
            let after = state.store.source_file_paths(source_id).unwrap_or_default();
            let added = after.difference(&before).count();
            let removed = before.difference(&after).count();
            emit("finished", added, removed, None);
            Ok(result)
        }
        Err(error) => {
            if background {
                FAILED_AT.lock().insert(source_id.to_owned(), now());
            }
            emit("failed", 0, 0, Some(error.to_string()));
            Err(error)
        }
    }
}

/// Rescan every source that is due, one at a time.
async fn scan_due(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(sources) = state.store.list_media_sources() else {
        return;
    };
    for source in sources {
        let Ok(account) = state.store.get_account(&source.account_id) else {
            continue;
        };
        let failed_at = FAILED_AT.lock().get(&source.id).copied();
        if is_due(&source, &account.account.provider, now(), failed_at) {
            if let Err(error) = scan(app, &source.id, true).await {
                eprintln!("Cove: background scan of {} failed: {error}", source.label);
            }
        }
    }
}

/// Start keeping the library current: watch local folders and rescan due sources periodically.
pub fn start(app: AppHandle) {
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
    *CHANGED.lock() = Some(sender);
    watch_local_sources(&app);

    // Local folders that changed: wait for the changes to settle, then rescan each once.
    let changed_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(first) = receiver.recv().await {
            let mut pending = HashSet::from([first]);
            loop {
                match tokio::time::timeout(SETTLE, receiver.recv()).await {
                    Ok(Some(source_id)) => {
                        pending.insert(source_id);
                    }
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            for source_id in pending {
                let _ = scan(&changed_app, &source_id, true).await;
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            scan_due(&app).await;
            watch_local_sources(&app);
            tokio::time::sleep(TICK).await;
        }
    });
}

/// Whether a changed path can affect the library: media, subtitles, documents, or a folder.
fn relevant(path: &std::path::Path) -> bool {
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    if name.starts_with('.') {
        return false;
    }
    match path.extension().and_then(|extension| extension.to_str()) {
        None => true,
        Some(_) => {
            crate::media_types::is_media(name) || crate::media_types::is_document(name)
        }
    }
}

/// (Re)watch the folders of local sources; called at start, when a source is added, and each tick.
pub(crate) fn watch_local_sources(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(sources) = state.store.list_media_sources() else {
        return;
    };
    let wanted: Vec<(PathBuf, String)> = sources
        .into_iter()
        .filter(|source| source.account_id == "local" && source.remote_root != "/")
        .map(|source| (PathBuf::from(&source.remote_root), source.id))
        .filter(|(root, _)| root.is_dir())
        .collect();
    if *WATCHED.lock() == wanted {
        return;
    }
    let mut watcher_slot = WATCHER.lock();
    *watcher_slot = None;
    *WATCHED.lock() = wanted.clone();
    if wanted.is_empty() {
        return;
    }
    let roots = wanted.clone();
    let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else {
            return;
        };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let Some(sender) = CHANGED.lock().clone() else {
            return;
        };
        for path in event.paths.iter().filter(|path| relevant(path)) {
            for (root, source_id) in &roots {
                if path.starts_with(root) {
                    let _ = sender.send(source_id.clone());
                }
            }
        }
    });
    let Ok(mut watcher) = watcher else {
        return;
    };
    for (root, _) in &wanted {
        if let Err(error) = watcher.watch(root, RecursiveMode::Recursive) {
            eprintln!("Cove: cannot watch {}: {error}", root.display());
        }
    }
    *watcher_slot = Some(watcher);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(last_scan_at: Option<i64>) -> MediaSource {
        MediaSource {
            id: "s".into(),
            account_id: "a".into(),
            kind: "movie".into(),
            remote_root: "/影视".into(),
            label: "影视".into(),
            last_scan_at,
        }
    }

    #[test]
    fn cloud_folders_refresh_every_few_hours_and_local_ones_more_often() {
        let now = 1_000_000;
        assert!(is_due(&source(None), "baidu", now, None));
        assert!(!is_due(&source(Some(now - 60 * 60)), "baidu", now, None));
        assert!(is_due(&source(Some(now - CLOUD_INTERVAL)), "baidu", now, None));
        assert!(is_due(&source(Some(now - 31 * 60)), "local", now, None));
        assert!(!is_due(&source(Some(now - 10 * 60)), "local", now, None));
    }

    #[test]
    fn a_failed_folder_waits_and_the_whole_drive_is_never_scanned() {
        let now = 1_000_000;
        assert!(!is_due(&source(None), "baidu", now, Some(now - 10 * 60)));
        assert!(is_due(&source(None), "baidu", now, Some(now - RETRY_AFTER)));
        let mut root = source(None);
        root.remote_root = "/".into();
        assert!(!is_due(&root, "baidu", now, None));
    }

    #[test]
    fn only_library_files_and_folders_trigger_a_rescan() {
        assert!(relevant(std::path::Path::new("/Movies/New.Film.2024.mkv")));
        assert!(relevant(std::path::Path::new("/Movies/New Folder")));
        assert!(relevant(std::path::Path::new("/Books/a.pdf")));
        assert!(!relevant(std::path::Path::new("/Movies/.DS_Store")));
        assert!(!relevant(std::path::Path::new("/Movies/poster.jpg")));
        assert!(!relevant(std::path::Path::new("/Movies/film.mkv.part")));
    }

    #[test]
    fn one_scan_per_source_at_a_time() {
        let first = ScanGuard::acquire("busy").expect("free");
        assert!(ScanGuard::acquire("busy").is_none());
        assert!(ScanGuard::acquire("other").is_some());
        drop(first);
        assert!(ScanGuard::acquire("busy").is_some());
    }
}
