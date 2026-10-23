//! Keeping several computers in step through a folder they can all reach (Baidu Netdisk, WebDAV, a
//! share, or a folder another app syncs). Each computer writes only its own file there,
//! `cove-<device>.json`, holding its media folders, playback and reading progress, play counts,
//! playlists and what it deleted, and merges everyone else's files into its library: for each
//! record the newer one wins. Files are matched by the account they are on (the same Baidu user,
//! WebDAV address or share) and their path there; local disks differ from computer to computer and
//! are left out. Passwords and sign-ins never leave the computer.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    error::{NimbusError, Result},
    AppState,
};

const FORMAT: u32 = 1;
const INTERVAL: Duration = Duration::from_secs(5 * 60);
const STARTUP_DELAY: Duration = Duration::from_secs(20);
pub const DEFAULT_FOLDER: &str = "/Cove 同步";

/// One sync at a time, whether started by the timer or by 立即同步.
static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static WAKE: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncFile {
    pub version: u32,
    pub device: String,
    pub device_name: String,
    #[serde(default)]
    pub exported_at: i64,
    #[serde(default)]
    pub sources: Vec<SourceRecord>,
    #[serde(default)]
    pub progress: Vec<ProgressRecord>,
    #[serde(default)]
    pub plays: Vec<PlayRecord>,
    #[serde(default)]
    pub reading: Vec<ReadingRecord>,
    #[serde(default)]
    pub playlists: Vec<PlaylistRecord>,
    #[serde(default)]
    pub deleted: Vec<DeletedRecord>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceRecord {
    pub account: String,
    pub kind: String,
    pub root: String,
    pub label: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressRecord {
    pub account: String,
    pub path: String,
    pub position: f64,
    pub duration: f64,
    pub speed: f64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayRecord {
    pub account: String,
    pub path: String,
    pub count: i64,
    pub last_played_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadingRecord {
    pub account: String,
    pub path: String,
    pub entry_id: String,
    pub name: String,
    pub size: i64,
    pub page: i64,
    pub page_count: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileRef {
    pub account: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaylistRecord {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub items: Vec<FileRef>,
}

/// Something deleted here, so other computers delete it too. `key` is "account\tkind\troot" for a
/// media folder, "account\tpath" for progress (a video marked 未看) and the id for a playlist.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeletedRecord {
    pub kind: String,
    pub key: String,
    pub deleted_at: i64,
}

/// What merging other computers' files changed here.
#[derive(Default, Debug)]
pub(crate) struct Applied {
    pub changed: bool,
    pub new_sources: Vec<String>,
}

// Deletions are recorded inside the transaction that deletes, while the account and path are known.

pub(crate) fn record_source_deleted(transaction: &Transaction, source_id: &str) -> Result<()> {
    transaction.execute(
        "INSERT INTO sync_deleted (kind, key, deleted_at)
         SELECT 'source', a.sync_identity || char(9) || s.kind || char(9) || s.remote_root, unixepoch()
         FROM media_sources s JOIN accounts a ON a.id = s.account_id
         WHERE s.id = ?1 AND a.sync_identity IS NOT NULL
         ON CONFLICT (kind, key) DO UPDATE SET deleted_at = excluded.deleted_at",
        [source_id],
    )?;
    Ok(())
}

pub(crate) fn record_progress_deleted(transaction: &Transaction, file_id: &str) -> Result<()> {
    transaction.execute(
        "INSERT INTO sync_deleted (kind, key, deleted_at)
         SELECT 'progress', a.sync_identity || char(9) || COALESCE(f.cloud_path, f.remote_path), unixepoch()
         FROM media_files f JOIN accounts a ON a.id = f.account_id
         WHERE f.id = ?1 AND a.sync_identity IS NOT NULL
           AND EXISTS (SELECT 1 FROM playback_progress WHERE file_id = f.id)
         ON CONFLICT (kind, key) DO UPDATE SET deleted_at = excluded.deleted_at",
        [file_id],
    )?;
    Ok(())
}

pub(crate) fn record_playlist_deleted(transaction: &Transaction, id: &str) -> Result<()> {
    transaction.execute(
        "INSERT INTO sync_deleted (kind, key, deleted_at) VALUES ('playlist', ?1, unixepoch())
         ON CONFLICT (kind, key) DO UPDATE SET deleted_at = excluded.deleted_at",
        [id],
    )?;
    Ok(())
}

fn rows<T>(
    transaction: &Transaction,
    sql: &str,
    map: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut statement = transaction.prepare(sql)?;
    let rows = statement.query_map([], map)?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Everything this computer shares, as its sync file holds it.
pub(crate) fn export(transaction: &Transaction, device: &str, device_name: &str) -> Result<SyncFile> {
    let sources = rows(
        transaction,
        "SELECT a.sync_identity, s.kind, s.remote_root, s.label, s.created_at
         FROM media_sources s JOIN accounts a ON a.id = s.account_id
         WHERE a.sync_identity IS NOT NULL ORDER BY s.created_at, s.rowid",
        |row| {
            Ok(SourceRecord {
                account: row.get(0)?,
                kind: row.get(1)?,
                root: row.get(2)?,
                label: row.get(3)?,
                created_at: row.get(4)?,
            })
        },
    )?;
    let progress = rows(
        transaction,
        "SELECT a.sync_identity, COALESCE(f.cloud_path, f.remote_path), p.position_sec, p.duration_sec, p.speed, p.updated_at
         FROM playback_progress p JOIN media_files f ON f.id = p.file_id JOIN accounts a ON a.id = f.account_id
         WHERE a.sync_identity IS NOT NULL ORDER BY p.updated_at, f.rowid",
        |row| {
            Ok(ProgressRecord {
                account: row.get(0)?,
                path: row.get(1)?,
                position: row.get(2)?,
                duration: row.get(3)?,
                speed: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )?;
    let plays = rows(
        transaction,
        "SELECT a.sync_identity, COALESCE(f.cloud_path, f.remote_path), h.play_count, h.last_played_at
         FROM play_history h JOIN media_files f ON f.id = h.file_id JOIN accounts a ON a.id = f.account_id
         WHERE a.sync_identity IS NOT NULL ORDER BY h.last_played_at, f.rowid",
        |row| {
            Ok(PlayRecord {
                account: row.get(0)?,
                path: row.get(1)?,
                count: row.get(2)?,
                last_played_at: row.get(3)?,
            })
        },
    )?;
    let reading = rows(
        transaction,
        "SELECT a.sync_identity, r.path, r.entry_id, r.name, r.size, r.page, r.page_count, r.updated_at
         FROM reading_progress r JOIN accounts a ON a.id = r.account_id
         WHERE a.sync_identity IS NOT NULL ORDER BY r.updated_at, r.doc_key",
        |row| {
            Ok(ReadingRecord {
                account: row.get(0)?,
                path: row.get(1)?,
                entry_id: row.get(2)?,
                name: row.get(3)?,
                size: row.get(4)?,
                page: row.get(5)?,
                page_count: row.get(6)?,
                updated_at: row.get(7)?,
            })
        },
    )?;
    let mut playlists = rows(
        transaction,
        "SELECT id, name, created_at, updated_at FROM playlists ORDER BY created_at, id",
        |row| {
            Ok(PlaylistRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                items: Vec::new(),
            })
        },
    )?;
    {
        let mut statement = transaction.prepare(
            "SELECT a.sync_identity, COALESCE(f.cloud_path, f.remote_path)
             FROM playlist_items i JOIN media_files f ON f.id = i.file_id JOIN accounts a ON a.id = f.account_id
             WHERE i.playlist_id = ?1 AND a.sync_identity IS NOT NULL ORDER BY i.position",
        )?;
        for playlist in &mut playlists {
            let items = statement.query_map([&playlist.id], |row| {
                Ok(FileRef {
                    account: row.get(0)?,
                    path: row.get(1)?,
                })
            })?;
            playlist.items = items.collect::<std::result::Result<Vec<_>, _>>()?;
        }
    }
    let deleted = rows(
        transaction,
        "SELECT kind, key, deleted_at FROM sync_deleted ORDER BY deleted_at, kind, key",
        |row| {
            Ok(DeletedRecord {
                kind: row.get(0)?,
                key: row.get(1)?,
                deleted_at: row.get(2)?,
            })
        },
    )?;
    Ok(SyncFile {
        version: FORMAT,
        device: device.to_owned(),
        device_name: device_name.to_owned(),
        exported_at: 0,
        sources,
        progress,
        plays,
        reading,
        playlists,
        deleted,
    })
}

/// Merges another computer's file into this library; for each record the newer one wins.
pub(crate) fn apply(transaction: &Transaction, remote: &SyncFile) -> Result<Applied> {
    let mut applied = Applied::default();
    // Account identities here, and the files on those accounts by path.
    let mut accounts: HashMap<String, String> = HashMap::new();
    for (identity, id) in rows(
        transaction,
        "SELECT sync_identity, id FROM accounts WHERE sync_identity IS NOT NULL ORDER BY created_at DESC",
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )? {
        // The oldest account wins when the same one was added twice.
        accounts.insert(identity, id);
    }
    let mut files: HashMap<(String, String), String> = HashMap::new();
    for (account, path, id) in rows(
        transaction,
        "SELECT f.account_id, COALESCE(f.cloud_path, f.remote_path), f.id
         FROM media_files f JOIN accounts a ON a.id = f.account_id
         WHERE a.sync_identity IS NOT NULL ORDER BY f.rowid DESC",
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
    )? {
        files.insert((account, path), id);
    }
    let file = |account: &str, path: &str| -> Option<String> {
        let account = accounts.get(account)?;
        files.get(&(account.clone(), path.to_owned())).cloned()
    };
    let deleted_at = |kind: &str, key: &str| -> Result<Option<i64>> {
        Ok(transaction
            .query_row(
                "SELECT deleted_at FROM sync_deleted WHERE kind = ?1 AND key = ?2",
                params![kind, key],
                |row| row.get(0),
            )
            .optional()?)
    };

    for record in &remote.deleted {
        transaction.execute(
            "INSERT INTO sync_deleted (kind, key, deleted_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (kind, key) DO UPDATE SET deleted_at = max(deleted_at, excluded.deleted_at)",
            params![record.kind, record.key, record.deleted_at],
        )?;
        let parts: Vec<&str> = record.key.split('\t').collect();
        let changed = match (record.kind.as_str(), parts.as_slice()) {
            ("source", [account, kind, root]) => match accounts.get(*account) {
                Some(account) => {
                    let ids = {
                        let mut statement = transaction.prepare(
                            "SELECT id FROM media_sources WHERE account_id = ?1 AND kind = ?2 AND remote_root = ?3 AND created_at <= ?4",
                        )?;
                        let ids = statement.query_map(params![account, kind, root, record.deleted_at], |row| row.get::<_, String>(0))?;
                        ids.collect::<std::result::Result<Vec<_>, _>>()?
                    };
                    for id in &ids {
                        transaction.execute("DELETE FROM source_files WHERE source_id = ?1", [id])?;
                        transaction.execute("DELETE FROM media_sources WHERE id = ?1", [id])?;
                    }
                    ids.len()
                }
                None => 0,
            },
            ("progress", [account, path]) => match file(account, path) {
                Some(id) => transaction.execute(
                    "DELETE FROM playback_progress WHERE file_id = ?1 AND updated_at <= ?2",
                    params![id, record.deleted_at],
                )?,
                None => 0,
            },
            ("playlist", _) => transaction.execute(
                "DELETE FROM playlists WHERE id = ?1 AND updated_at <= ?2",
                params![record.key, record.deleted_at],
            )?,
            _ => 0,
        };
        applied.changed |= changed > 0;
    }

    for record in &remote.sources {
        let Some(account) = accounts.get(&record.account) else { continue };
        if !matches!(record.kind.as_str(), "movie" | "music" | "document" | "course") {
            continue;
        }
        let key = format!("{}\t{}\t{}", record.account, record.kind, record.root);
        if deleted_at("source", &key)?.is_some_and(|at| at >= record.created_at) {
            continue;
        }
        let exists: bool = transaction.query_row(
            "SELECT EXISTS (SELECT 1 FROM media_sources WHERE account_id = ?1 AND kind = ?2 AND remote_root = ?3)",
            params![account, record.kind, record.root],
            |row| row.get(0),
        )?;
        if exists {
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO media_sources (id, account_id, kind, remote_root, label, last_scan_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
            params![id, account, record.kind, record.root, record.label, record.created_at],
        )?;
        applied.changed = true;
        applied.new_sources.push(id);
    }

    for record in &remote.progress {
        let Some(id) = file(&record.account, &record.path) else { continue };
        let key = format!("{}\t{}", record.account, record.path);
        if deleted_at("progress", &key)?.is_some_and(|at| at >= record.updated_at) {
            continue;
        }
        let changed = transaction.execute(
            "INSERT INTO playback_progress (file_id, position_sec, duration_sec, speed, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (file_id) DO UPDATE SET position_sec = excluded.position_sec,
               duration_sec = excluded.duration_sec, speed = excluded.speed, updated_at = excluded.updated_at
             WHERE excluded.updated_at > playback_progress.updated_at",
            params![id, record.position, record.duration, record.speed.clamp(0.25, 4.0), record.updated_at],
        )?;
        applied.changed |= changed > 0;
    }

    for record in &remote.plays {
        let Some(id) = file(&record.account, &record.path) else { continue };
        let changed = transaction.execute(
            "INSERT INTO play_history (file_id, play_count, last_played_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (file_id) DO UPDATE SET play_count = max(play_count, excluded.play_count),
               last_played_at = max(last_played_at, excluded.last_played_at)
             WHERE excluded.play_count > play_history.play_count OR excluded.last_played_at > play_history.last_played_at",
            params![id, record.count, record.last_played_at],
        )?;
        applied.changed |= changed > 0;
    }

    for record in &remote.reading {
        let Some(account) = accounts.get(&record.account) else { continue };
        let changed = transaction.execute(
            "INSERT INTO reading_progress (doc_key, account_id, path, entry_id, name, size, page, page_count, updated_at)
             VALUES (?1 || ':' || ?3, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (doc_key) DO UPDATE SET entry_id = excluded.entry_id, name = excluded.name,
               size = excluded.size, page = excluded.page, page_count = excluded.page_count,
               updated_at = excluded.updated_at
             WHERE excluded.updated_at > reading_progress.updated_at",
            params![
                account,
                account,
                record.path,
                record.entry_id,
                record.name,
                record.size,
                record.page,
                record.page_count,
                record.updated_at
            ],
        )?;
        applied.changed |= changed > 0;
    }

    for record in &remote.playlists {
        if deleted_at("playlist", &record.id)?.is_some_and(|at| at >= record.updated_at) {
            continue;
        }
        let local: Option<i64> = transaction
            .query_row("SELECT updated_at FROM playlists WHERE id = ?1", [&record.id], |row| row.get(0))
            .optional()?;
        if local.is_some_and(|updated| updated >= record.updated_at) {
            continue;
        }
        transaction.execute(
            "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
            params![record.id, record.name, record.created_at, record.updated_at],
        )?;
        transaction.execute("DELETE FROM playlist_items WHERE playlist_id = ?1", [&record.id])?;
        let mut position = 0i64;
        let mut missing = false;
        for item in &record.items {
            let Some(file_id) = file(&item.account, &item.path) else {
                missing = true;
                continue;
            };
            position += transaction.execute(
                "INSERT OR IGNORE INTO playlist_items (playlist_id, file_id, position) VALUES (?1, ?2, ?3)",
                params![record.id, file_id, position],
            )? as i64;
        }
        if missing {
            // Some songs are not scanned here yet: stay a second older, so the next round fills them
            // in, and this computer's copy never wins over the complete one.
            transaction.execute(
                "UPDATE playlists SET updated_at = ?2 WHERE id = ?1",
                params![record.id, record.updated_at - 1],
            )?;
        }
        applied.changed = true;
    }
    Ok(applied)
}

// ---- Settings ----

fn setting(transaction: &Transaction, key: &str) -> Result<Option<String>> {
    Ok(transaction
        .query_row("SELECT value FROM sync_settings WHERE key = ?1", [key], |row| row.get(0))
        .optional()?)
}

fn set_setting(transaction: &Transaction, key: &str, value: Option<&str>) -> Result<()> {
    match value {
        Some(value) => transaction.execute(
            "INSERT INTO sync_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?,
        None => transaction.execute("DELETE FROM sync_settings WHERE key = ?1", [key])?,
    };
    Ok(())
}

fn computer_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !name.is_empty() {
            return name;
        }
    }
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| if cfg!(windows) { "Windows 电脑".into() } else { "Mac".into() })
}

/// This computer's id and name, made on first use.
fn device(transaction: &Transaction) -> Result<(String, String)> {
    let id = match setting(transaction, "device")? {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().simple().to_string();
            set_setting(transaction, "device", Some(&id))?;
            id
        }
    };
    let name = match setting(transaction, "device_name")? {
        Some(name) => name,
        None => computer_name(),
    };
    Ok((id, name))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncDevice {
    name: String,
    synced_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStatus {
    account_id: Option<String>,
    folder: String,
    device_name: String,
    last_sync_at: Option<i64>,
    last_error: Option<String>,
    /// The other computers whose files were last seen in the folder.
    devices: Vec<SyncDevice>,
    running: bool,
}

pub(crate) fn status(state: &AppState) -> Result<SyncStatus> {
    state.store.transaction(|transaction| {
        let (_, device_name) = device(transaction)?;
        let account_id = setting(transaction, "account")?;
        let mut folder = setting(transaction, "folder")?.unwrap_or_else(|| DEFAULT_FOLDER.to_owned());
        let local: bool = transaction.query_row(
            "SELECT EXISTS (SELECT 1 FROM accounts WHERE id = ?1 AND provider = 'local')",
            [&account_id],
            |row| row.get(0),
        )?;
        if local {
            folder = crate::paths::native(&folder).to_string_lossy().into_owned();
        }
        Ok(SyncStatus {
            account_id,
            folder,
            device_name,
            last_sync_at: setting(transaction, "last_sync_at")?.and_then(|value| value.parse().ok()),
            last_error: setting(transaction, "last_error")?,
            devices: setting(transaction, "devices")?
                .and_then(|json| serde_json::from_str::<Vec<(String, i64)>>(&json).ok())
                .unwrap_or_default()
                .into_iter()
                .map(|(name, synced_at)| SyncDevice { name, synced_at })
                .collect(),
            running: RUNNING.try_lock().is_err(),
        })
    })
}

/// Turns sync on (an account and a folder on it) or off (no account).
pub(crate) fn configure(state: &AppState, account_id: Option<String>, folder: String, device_name: String) -> Result<()> {
    let mut folder = match folder.trim().trim_end_matches(['/', '\\']) {
        "" => DEFAULT_FOLDER.to_owned(),
        folder if folder.starts_with('/') => folder.to_owned(),
        folder => format!("/{folder}"),
    };
    if let Some(account_id) = &account_id {
        let account = state.store.get_account(account_id)?.account;
        if !matches!(account.provider.as_str(), "baidu" | "webdav" | "smb" | "local") {
            return Err(NimbusError::Validation("同步文件夹只能放在百度网盘、WebDAV、SMB 共享或本机文件夹中".into()));
        }
        if account.provider == "local" {
            // Typed as this system writes paths, such as C:\Users\me\OneDrive\Cove 同步.
            let native = Path::new(folder.trim_start_matches('/').trim());
            let native = if cfg!(windows) { native.to_path_buf() } else { Path::new("/").join(native) };
            if !native.is_absolute() {
                return Err(NimbusError::Validation("本机文件夹需要填写完整路径".into()));
            }
            folder = crate::paths::portable(&native);
        }
    }
    state.store.transaction(|transaction| {
        set_setting(transaction, "account", account_id.as_deref())?;
        set_setting(transaction, "folder", Some(&folder))?;
        let name = device_name.trim();
        set_setting(transaction, "device_name", (!name.is_empty()).then_some(name))?;
        set_setting(transaction, "last_error", None)?;
        // The new place may not hold this computer's file yet.
        set_setting(transaction, "written", None)?;
        Ok(())
    })?;
    WAKE.notify_one();
    Ok(())
}

// ---- Account identities ----

/// Gives every account the identity it has on every computer; cloud accounts ask their service once.
async fn identify_accounts(state: &AppState) {
    let Ok(accounts) = state.store.transaction(|transaction| {
        rows(
            transaction,
            "SELECT id, provider, endpoint, sync_identity FROM accounts WHERE provider <> 'local'",
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
    }) else {
        return;
    };
    for (id, provider, endpoint, current) in accounts {
        let identity = match provider.as_str() {
            "webdav" => Some(format!("webdav:{}", endpoint.trim_end_matches('/'))),
            "smb" => Some(format!("smb:{}", endpoint.trim_end_matches('/').to_lowercase())),
            _ if current.is_some() => continue,
            _ => match crate::credentials::get(&state.store, &state.credentials, &id).await {
                Ok((_, token)) => crate::direct::account_identity(&provider, &token).await.ok(),
                Err(_) => None,
            },
        };
        if let Some(identity) = identity.filter(|identity| current.as_ref() != Some(identity)) {
            let _ = state.store.transaction(|transaction| {
                transaction.execute("UPDATE accounts SET sync_identity = ?1 WHERE id = ?2", params![identity, id])?;
                Ok(())
            });
        }
    }
}

// ---- The sync folder ----

struct Folder {
    account_id: String,
    provider: String,
    path: String,
}

struct Entry {
    name: String,
    id: String,
}

impl Folder {
    async fn local_directory(&self, state: &AppState) -> Result<PathBuf> {
        if self.provider == "smb" {
            let root = crate::smb::ensure_mounted(state, &self.account_id).await?;
            return crate::smb::to_local(&root, &self.path);
        }
        Ok(crate::paths::native(&self.path))
    }

    /// The sync files in the folder, making the folder if it is not there yet.
    async fn list(&self, state: &AppState) -> Result<Vec<Entry>> {
        let entries = match self.provider.as_str() {
            "local" | "smb" => {
                let directory = self.local_directory(state).await?;
                tokio::fs::create_dir_all(&directory).await?;
                let mut entries = Vec::new();
                let mut reader = tokio::fs::read_dir(&directory).await?;
                while let Some(entry) = reader.next_entry().await? {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    entries.push(Entry { id: name.clone(), name });
                }
                entries
            }
            "webdav" => {
                let (stored, password) = crate::credentials::get(&state.store, &state.credentials, &self.account_id).await?;
                let username = stored.account.username.clone().unwrap_or_default();
                crate::webdav::make_folder(&stored.account.endpoint, &self.path, &username, &password).await?;
                crate::webdav::browse(&stored.account.endpoint, &self.path, &username, &password)
                    .await?
                    .into_iter()
                    .filter(|entry| !entry.is_dir)
                    .map(|entry| Entry { name: entry.name, id: entry.id })
                    .collect()
            }
            _ => {
                let (_, token) = crate::credentials::get(&state.store, &state.credentials, &self.account_id).await?;
                let listed = match crate::direct::browse("baidu", &token, &self.path).await {
                    Ok(listed) => listed,
                    Err(NimbusError::Validation(_)) => {
                        // Not there yet; checking the parent keeps a second folder from being made.
                        let (parent, name) = self.path.trim_end_matches('/').rsplit_once('/').unwrap_or(("", &self.path));
                        let parent = if parent.is_empty() { "/" } else { parent };
                        let exists = crate::direct::browse("baidu", &token, parent)
                            .await?
                            .into_iter()
                            .any(|entry| entry.is_dir && entry.name == name);
                        if exists {
                            return Err(NimbusError::Validation("无法读取百度网盘中的同步文件夹".into()));
                        }
                        crate::direct::create_baidu_folder(&token, parent, name).await?;
                        Vec::new()
                    }
                    Err(error) => return Err(error),
                };
                listed
                    .into_iter()
                    .filter(|entry| !entry.is_dir)
                    .map(|entry| Entry { name: entry.name, id: entry.id })
                    .collect()
            }
        };
        Ok(entries
            .into_iter()
            .filter(|entry| entry.name.starts_with("cove-") && entry.name.ends_with(".json"))
            .collect())
    }

    async fn read(&self, state: &AppState, entry: &Entry) -> Result<Vec<u8>> {
        match self.provider.as_str() {
            "local" | "smb" => Ok(tokio::fs::read(self.local_directory(state).await?.join(&entry.name)).await?),
            "webdav" => {
                let (stored, password) = crate::credentials::get(&state.store, &state.credentials, &self.account_id).await?;
                let username = stored.account.username.clone().unwrap_or_default();
                crate::webdav::read_file(&stored.account.endpoint, &self.path, &entry.name, &username, &password).await
            }
            _ => {
                let (_, token) = crate::credentials::get(&state.store, &state.credentials, &self.account_id).await?;
                let fs_id = entry.id.parse().map_err(|_| NimbusError::Validation("百度文件缺少文件标识".into()))?;
                crate::direct::read_baidu_file(&token, fs_id).await
            }
        }
    }

    async fn write(&self, state: &AppState, name: &str, contents: Vec<u8>) -> Result<()> {
        match self.provider.as_str() {
            "local" | "smb" => {
                let directory = self.local_directory(state).await?;
                let temporary = directory.join(format!(".{name}.tmp"));
                tokio::fs::write(&temporary, contents).await?;
                tokio::fs::rename(&temporary, directory.join(name)).await?;
                Ok(())
            }
            "webdav" => {
                let (stored, password) = crate::credentials::get(&state.store, &state.credentials, &self.account_id).await?;
                let username = stored.account.username.clone().unwrap_or_default();
                crate::webdav::write_file(&stored.account.endpoint, &self.path, name, contents, &username, &password).await
            }
            _ => {
                let (_, token) = crate::credentials::get(&state.store, &state.credentials, &self.account_id).await?;
                let directory = std::env::temp_dir().join(format!("cove-sync-{}", uuid::Uuid::new_v4().simple()));
                tokio::fs::create_dir_all(&directory).await?;
                let local = directory.join(name);
                tokio::fs::write(&local, contents).await?;
                let remote = format!("{}/{}", self.path.trim_end_matches('/'), name);
                let result = crate::direct::replace_baidu_file(&token, &local, &remote).await;
                let _ = tokio::fs::remove_dir_all(&directory).await;
                result
            }
        }
    }
}

// ---- Running ----

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

/// One round: read the other computers' files, merge them, then write this computer's file if it changed.
pub(crate) async fn run(app: &AppHandle) -> Result<()> {
    let _running = RUNNING.lock().await;
    let state = app.state::<AppState>();
    let settings = state.store.transaction(|transaction| {
        Ok((setting(transaction, "account")?, setting(transaction, "folder")?, device(transaction)?))
    })?;
    let (Some(account_id), folder, (device, device_name)) = settings else {
        return Ok(());
    };
    let _ = app.emit("sync-state", "started");
    let result = run_with(app, &state, account_id, folder.unwrap_or_else(|| DEFAULT_FOLDER.to_owned()), &device, &device_name).await;
    let error = result.as_ref().err().map(ToString::to_string);
    let _ = state.store.transaction(|transaction| {
        set_setting(transaction, "last_error", error.as_deref())?;
        if error.is_none() {
            set_setting(transaction, "last_sync_at", Some(&now().to_string()))?;
        }
        Ok(())
    });
    let _ = app.emit("sync-state", if error.is_some() { "failed" } else { "finished" });
    result
}

async fn run_with(
    app: &AppHandle,
    state: &AppState,
    account_id: String,
    path: String,
    device: &str,
    device_name: &str,
) -> Result<()> {
    let provider = state.store.get_account(&account_id)?.account.provider;
    identify_accounts(state).await;
    let folder = Folder { account_id, provider, path };
    let own = format!("cove-{device}.json");
    let entries = folder.list(state).await?;

    let mut others = Vec::new();
    for entry in entries.iter().filter(|entry| entry.name != own) {
        let contents = folder.read(state, entry).await?;
        match serde_json::from_slice::<SyncFile>(&contents) {
            Ok(file) if file.version <= FORMAT && file.device != device => others.push(file),
            // A file from a newer Cove, or not a sync file: leave it alone.
            _ => continue,
        }
    }
    let mut new_sources = Vec::new();
    let mut changed = false;
    for file in &others {
        let applied = state.store.transaction(|transaction| apply(transaction, file))?;
        changed |= applied.changed;
        new_sources.extend(applied.new_sources);
    }
    let devices: Vec<(String, i64)> = others.iter().map(|file| (file.device_name.clone(), file.exported_at)).collect();

    let mut file = state.store.transaction(|transaction| export(transaction, device, device_name))?;
    let fingerprint = format!("{:x}", md5::compute(serde_json::to_vec(&file)?));
    let written = state.store.transaction(|transaction| setting(transaction, "written"))?;
    if written.as_deref() != Some(fingerprint.as_str()) || !entries.iter().any(|entry| entry.name == own) {
        file.exported_at = now();
        folder.write(state, &own, serde_json::to_vec_pretty(&file)?).await?;
    }
    state.store.transaction(|transaction| {
        set_setting(transaction, "written", Some(&fingerprint))?;
        set_setting(transaction, "devices", Some(&serde_json::to_string(&devices)?))
    })?;

    if !new_sources.is_empty() {
        crate::auto_scan::watch_local_sources(app);
        for id in new_sources {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::auto_scan::scan(&app, &id, true).await;
                // Progress and playlists for the folder's files can be merged once they are known.
                WAKE.notify_one();
            });
        }
    }
    if changed {
        let _ = app.emit("sync-applied", ());
    }
    Ok(())
}

/// Syncs a little after launch, then every few minutes and whenever the settings change.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            if let Err(error) = run(&app).await {
                eprintln!("Cove sync failed: {error}");
            }
            let _ = tokio::time::timeout(INTERVAL, WAKE.notified()).await;
        }
    });
}

#[cfg(test)]
#[path = "tests/sync.rs"]
mod tests;
