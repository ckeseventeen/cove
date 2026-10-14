use std::{fs, path::Path};

use rusqlite::{params, Connection};

use crate::{
    error::{NimbusError, Result},
    model::{Account, MediaFile, MediaSource, Playlist, ReadingProgress, StoredAccount},
};

pub struct Store {
    connection: parking_lot::Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| crate::error::NimbusError::Internal(error.to_string()))?;
        }
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        connection.execute_batch(include_str!("../migrations/001_initial.sql"))?;
        let account_schema: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'",
            [],
            |row| row.get(0),
        )?;
        if account_schema.contains("CHECK (provider IN ('webdav'))") {
            connection.execute_batch(
                "PRAGMA foreign_keys = OFF;
                 BEGIN;
                 CREATE TABLE accounts_v2 (
                   id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL,
                   endpoint TEXT NOT NULL, username TEXT, secret_ref TEXT NOT NULL UNIQUE,
                   caps_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ok',
                   created_at INTEGER NOT NULL
                 );
                 INSERT INTO accounts_v2 SELECT * FROM accounts;
                 DROP TABLE accounts;
                 ALTER TABLE accounts_v2 RENAME TO accounts;
                 COMMIT;
                 PRAGMA foreign_keys = ON;",
            )?;
        }
        let media_columns: Vec<String> = {
            let mut statement = connection.prepare("PRAGMA table_info(media_files)")?;
            let columns = statement
                .query_map([], |row| row.get(1))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            columns
        };
        if !media_columns.iter().any(|column| column == "source_id") {
            connection.execute_batch(
                "ALTER TABLE media_files ADD COLUMN source_id TEXT;
                 ALTER TABLE media_files ADD COLUMN media_kind TEXT;
                 CREATE INDEX IF NOT EXISTS idx_media_files_source ON media_files(source_id);",
            )?;
        }
        if !media_columns.iter().any(|column| column == "cloud_path") {
            connection.execute_batch("ALTER TABLE media_files ADD COLUMN cloud_path TEXT;")?;
        }
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata_cache (
            file_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL, PRIMARY KEY(file_id, kind));",
        )?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version < 2 {
            connection.execute_batch(include_str!("../migrations/002_source_memberships.sql"))?;
        }
        if version < 3 {
            connection.execute_batch("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS metadata_overrides(file_id TEXT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE, query TEXT NOT NULL); PRAGMA user_version=3; COMMIT;")?;
        }
        if version < 4 {
            // Media folders may now hold documents; SQLite needs a table rebuild to change a CHECK.
            let sources_schema: String = connection.query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_sources'",
                [],
                |row| row.get(0),
            )?;
            if !sources_schema.contains("'document'") {
                connection.execute_batch(
                    "PRAGMA foreign_keys = OFF;
                     BEGIN IMMEDIATE;
                     CREATE TABLE media_sources_v4 (
                       id TEXT PRIMARY KEY,
                       account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                       kind TEXT NOT NULL CHECK (kind IN ('movie', 'music', 'document')),
                       remote_root TEXT NOT NULL,
                       label TEXT NOT NULL,
                       last_scan_at INTEGER,
                       created_at INTEGER NOT NULL,
                       UNIQUE (account_id, kind, remote_root)
                     );
                     INSERT INTO media_sources_v4 (id, account_id, kind, remote_root, label, last_scan_at, created_at)
                       SELECT id, account_id, kind, remote_root, label, last_scan_at, created_at FROM media_sources;
                     DROP TABLE media_sources;
                     ALTER TABLE media_sources_v4 RENAME TO media_sources;
                     COMMIT;
                     PRAGMA foreign_keys = ON;",
                )?;
            }
            connection.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS reading_progress (
                   doc_key TEXT PRIMARY KEY,
                   account_id TEXT NOT NULL,
                   path TEXT NOT NULL,
                   entry_id TEXT NOT NULL DEFAULT '',
                   name TEXT NOT NULL,
                   size INTEGER NOT NULL DEFAULT 0,
                   page INTEGER NOT NULL DEFAULT 0,
                   page_count INTEGER NOT NULL DEFAULT 0,
                   updated_at INTEGER NOT NULL
                 );
                 PRAGMA user_version = 4;
                 COMMIT;",
            )?;
        }
        if version < 5 {
            connection.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS playlists (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS playlist_items (
                   playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                   file_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
                   position INTEGER NOT NULL,
                   PRIMARY KEY (playlist_id, file_id)
                 );
                 PRAGMA user_version = 5;
                 COMMIT;",
            )?;
        }
        if version < 6 {
            // Film details are now cached with the name they were looked up under.
            connection.execute_batch(
                "BEGIN IMMEDIATE;
                 DELETE FROM metadata_cache WHERE kind = 'movie-v4';
                 PRAGMA user_version = 6;
                 COMMIT;",
            )?;
        }
        if version < 7 {
            migrate_webdav_paths(&connection)?;
        }
        // Film details from an earlier lookup scheme are never read again.
        connection.execute(
            "DELETE FROM metadata_cache WHERE kind LIKE 'movie-v%' AND kind <> ?1",
            [crate::metadata::MOVIE_CACHE],
        )?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self {
            connection: parking_lot::Mutex::new(connection),
        })
    }

    pub fn list_playlists(&self) -> Result<Vec<Playlist>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, name, updated_at,
               COALESCE((SELECT group_concat(file_id, '|') FROM
                 (SELECT file_id FROM playlist_items WHERE playlist_id = playlists.id ORDER BY position)), '')
             FROM playlists ORDER BY created_at",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Playlist {
                id: row.get(0)?,
                name: row.get(1)?,
                updated_at: row.get(2)?,
                file_ids: row
                    .get::<_, String>(3)?
                    .split('|')
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .collect(),
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn create_playlist(&self, id: &str, name: &str, file_ids: &[String]) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1, ?2, unixepoch(), unixepoch())",
            params![id, name],
        )?;
        write_playlist_items(&transaction, id, file_ids)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn rename_playlist(&self, id: &str, name: &str) -> Result<()> {
        let changed = self.connection.lock().execute(
            "UPDATE playlists SET name = ?2, updated_at = unixepoch() WHERE id = ?1",
            params![id, name],
        )?;
        if changed == 0 {
            return Err(NimbusError::Validation("找不到这个播放列表".into()));
        }
        Ok(())
    }

    pub fn delete_playlist(&self, id: &str) -> Result<()> {
        self.connection
            .lock()
            .execute("DELETE FROM playlists WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Replace a playlist's songs with `file_ids`, in that order.
    pub fn set_playlist_items(&self, id: &str, file_ids: &[String]) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE playlists SET updated_at = unixepoch() WHERE id = ?1",
            [id],
        )?;
        if changed == 0 {
            return Err(NimbusError::Validation("找不到这个播放列表".into()));
        }
        transaction.execute("DELETE FROM playlist_items WHERE playlist_id = ?1", [id])?;
        write_playlist_items(&transaction, id, file_ids)?;
        transaction.commit()?;
        Ok(())
    }

    /// Record that a document was opened, keeping the page already reached.
    pub fn touch_reading_document(&self, document: &ReadingProgress) -> Result<ReadingProgress> {
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO reading_progress (doc_key, account_id, path, entry_id, name, size, page, page_count, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, unixepoch())
             ON CONFLICT(doc_key) DO UPDATE SET account_id = excluded.account_id, path = excluded.path,
               entry_id = excluded.entry_id, name = excluded.name, size = excluded.size, updated_at = excluded.updated_at",
            params![
                document.doc_key,
                document.account_id,
                document.path,
                document.entry_id,
                document.name,
                document.size
            ],
        )?;
        drop(connection);
        self.reading_progress(&document.doc_key)?
            .ok_or_else(|| NimbusError::Internal("阅读记录写入失败".into()))
    }

    pub fn save_reading_page(&self, doc_key: &str, page: u32, page_count: u32) -> Result<()> {
        self.connection.lock().execute(
            "UPDATE reading_progress SET page = ?2, page_count = ?3, updated_at = unixepoch() WHERE doc_key = ?1",
            params![doc_key, page, page_count],
        )?;
        Ok(())
    }

    pub fn reading_progress(&self, doc_key: &str) -> Result<Option<ReadingProgress>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT doc_key, account_id, path, entry_id, name, size, page, page_count, updated_at
             FROM reading_progress WHERE doc_key = ?1",
        )?;
        let mut rows = statement.query_map([doc_key], reading_row)?;
        Ok(rows.next().transpose()?)
    }

    pub fn list_reading_progress(&self, limit: usize) -> Result<Vec<ReadingProgress>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT doc_key, account_id, path, entry_id, name, size, page, page_count, updated_at
             FROM reading_progress WHERE account_id IN (SELECT id FROM accounts)
             ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit as i64], reading_row)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn metadata_override(&self, file_id: &str) -> Result<Option<String>> {
        let connection = self.connection.lock();
        let mut statement =
            connection.prepare("SELECT query FROM metadata_overrides WHERE file_id=?1")?;
        let mut rows = statement.query([file_id])?;
        Ok(rows.next()?.map(|row| row.get(0)).transpose()?)
    }
    pub fn save_metadata_override(&self, file_id: &str, query: &str) -> Result<()> {
        self.connection.lock().execute("INSERT INTO metadata_overrides(file_id,query) VALUES (?1,?2) ON CONFLICT(file_id) DO UPDATE SET query=excluded.query",params![file_id,query])?;
        Ok(())
    }
    /// Saved positions, newest first: enough videos for Home to pick one per film or series
    /// (finished episodes included, so it can offer the next one), and only the last few songs,
    /// so a long album cannot push the videos out.
    pub fn recent_playback(&self) -> Result<Vec<serde_json::Value>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "WITH saved AS (
               SELECT p.file_id, p.position_sec, p.duration_sec, p.updated_at,
                 COALESCE((SELECT ms.kind FROM media_sources ms JOIN source_files sf ON sf.source_id=ms.id WHERE sf.file_id=p.file_id AND sf.present=1 ORDER BY sf.source_id LIMIT 1), m.media_kind) AS kind
               FROM playback_progress p JOIN media_files m ON m.id=p.file_id
               WHERE EXISTS(SELECT 1 FROM source_files sf WHERE sf.file_id=p.file_id AND sf.present=1))
             SELECT * FROM (SELECT file_id, position_sec, duration_sec, updated_at FROM saved WHERE kind IS NOT 'music' ORDER BY updated_at DESC LIMIT 200)
             UNION ALL
             SELECT * FROM (SELECT file_id, position_sec, duration_sec, updated_at FROM saved WHERE kind IS 'music' ORDER BY updated_at DESC LIMIT 5)
             ORDER BY updated_at DESC",
        )?;
        let rows = statement.query_map([], |row| Ok(serde_json::json!({"fileId":row.get::<_,String>(0)?, "position":row.get::<_,f64>(1)?, "duration":row.get::<_,f64>(2)?, "updatedAt":row.get::<_,i64>(3)?})))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn cached_movies(&self) -> Result<std::collections::HashMap<String, serde_json::Value>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT file_id,payload FROM metadata_cache WHERE kind = ?1")?;
        let rows = statement.query_map([crate::metadata::MOVIE_CACHE], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        Ok(rows
            .filter_map(|row| {
                row.ok()
                    .and_then(|(id, json)| serde_json::from_str(&json).ok().map(|json| (id, json)))
            })
            .collect())
    }
    pub fn clear_metadata(&self) -> Result<()> {
        self.connection
            .lock()
            .execute("DELETE FROM metadata_cache", [])?;
        Ok(())
    }

    pub fn ensure_local_account(&self) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute(
            "INSERT OR IGNORE INTO accounts
             (id, provider, label, endpoint, username, secret_ref, caps_json, status, created_at)
             VALUES ('local', 'local', '本地磁盘', '/', NULL, 'local:none', '{\"browse\":true,\"copy\":true}', 'ok', unixepoch())",
            [],
        )?;
        Ok(())
    }

    pub fn cached_metadata(&self, file_id: &str, kind: &str) -> Result<Option<String>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT payload FROM metadata_cache WHERE file_id = ?1 AND kind = ?2 AND updated_at > unixepoch() - 604800")?;
        let mut rows = statement.query(params![file_id, kind])?;
        Ok(rows.next()?.map(|row| row.get(0)).transpose()?)
    }

    pub fn save_metadata(&self, file_id: &str, kind: &str, payload: &str) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO metadata_cache (file_id, kind, payload, updated_at)
             VALUES (?1, ?2, ?3, unixepoch())
             ON CONFLICT(file_id, kind) DO UPDATE SET
               payload = excluded.payload, updated_at = excluded.updated_at",
            params![file_id, kind, payload],
        )?;
        Ok(())
    }

    pub fn playback_progress(&self, file_id: &str) -> Result<Option<(f64, f64)>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT position_sec, speed FROM playback_progress WHERE file_id = ?1")?;
        let mut rows = statement.query([file_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some((row.get(0)?, row.get(1)?)))
        } else {
            Ok(None)
        }
    }

    pub fn save_playback_progress(
        &self,
        file_id: &str,
        position: f64,
        duration: f64,
        speed: f64,
    ) -> Result<()> {
        let connection = self.connection.lock();
        let finished = duration > 0.0 && position / duration >= 0.95;
        let position = if finished { 0.0 } else { position.max(0.0) };
        if position <= 0.0 && !finished {
            // Nothing played yet (still loading, or stopped at once): keep the earlier position,
            // since a saved 0 means finished and Home would move on to the next episode.
            return Ok(());
        }
        connection.execute(
            "INSERT INTO playback_progress (file_id, position_sec, duration_sec, speed, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch())
             ON CONFLICT(file_id) DO UPDATE SET position_sec=excluded.position_sec,
             duration_sec=excluded.duration_sec, speed=excluded.speed, updated_at=excluded.updated_at",
            params![file_id, position, duration.max(0.0), speed.clamp(0.25, 4.0)],
        )?;
        Ok(())
    }

    pub fn list_media_sources(&self) -> Result<Vec<MediaSource>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, account_id, kind, remote_root, label, last_scan_at
             FROM media_sources ORDER BY created_at",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(MediaSource {
                id: row.get(0)?,
                account_id: row.get(1)?,
                kind: row.get(2)?,
                remote_root: row.get(3)?,
                label: row.get(4)?,
                last_scan_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn insert_media_source(&self, source: &MediaSource) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO media_sources (id, account_id, kind, remote_root, label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())",
            params![
                source.id,
                source.account_id,
                source.kind,
                source.remote_root,
                source.label
            ],
        )?;
        Ok(())
    }

    pub fn get_media_source(&self, id: &str) -> Result<MediaSource> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT id, account_id, kind, remote_root, label, last_scan_at FROM media_sources WHERE id = ?1",
                [id],
                |row| Ok(MediaSource { id: row.get(0)?, account_id: row.get(1)?, kind: row.get(2)?, remote_root: row.get(3)?, label: row.get(4)?, last_scan_at: row.get(5)? }),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => NimbusError::Validation("找不到这个媒体来源".into()),
                other => other.into(),
            })
    }

    pub fn delete_media_source(&self, id: &str) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM source_files WHERE source_id = ?1", [id])?;
        transaction.execute("DELETE FROM media_sources WHERE id = ?1", [id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn replace_source_files(
        &self,
        source: &MediaSource,
        files: &[MediaFile],
        complete: bool,
    ) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        // Ensure a removed source cannot be recreated by a late scan completion.
        transaction.query_row(
            "SELECT id FROM media_sources WHERE id=?1",
            [&source.id],
            |row| row.get::<_, String>(0),
        )?;
        if complete {
            transaction.execute(
                "UPDATE source_files SET present=0 WHERE source_id=?1",
                [&source.id],
            )?;
        }
        for file in files {
            transaction.execute(
                "INSERT INTO media_files (id,account_id,remote_path,cloud_path,display_name,size,etag,mime_type,scan_state,source_id,media_kind)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'ready',?9,?10)
                 ON CONFLICT(account_id,remote_path) DO UPDATE SET cloud_path=excluded.cloud_path,
                 display_name=excluded.display_name,size=excluded.size,etag=excluded.etag,mime_type=excluded.mime_type,scan_state='ready'",
                params![file.id,file.account_id,file.remote_path,file.cloud_path,file.display_name,file.size,file.etag,file.mime_type,source.id,source.kind])?;
            transaction.execute(
                "INSERT INTO source_files(source_id,file_id,present)
                SELECT ?1,id,1 FROM media_files WHERE account_id=?2 AND remote_path=?3
                ON CONFLICT(source_id,file_id) DO UPDATE SET present=1",
                params![source.id, file.account_id, file.remote_path],
            )?;
        }
        if complete {
            transaction.execute(
                "UPDATE media_sources SET last_scan_at=unixepoch() WHERE id=?1",
                [&source.id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn list_accounts(&self) -> Result<Vec<Account>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, provider, label, endpoint, username, status FROM accounts ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Account {
                id: row.get(0)?,
                provider: row.get(1)?,
                label: row.get(2)?,
                endpoint: row.get(3)?,
                username: row.get(4)?,
                status: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn insert_account(&self, account: &Account, secret_ref: &str) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO accounts (id, provider, label, endpoint, username, secret_ref, caps_json, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', ?7, unixepoch())",
            params![account.id, account.provider, account.label, account.endpoint, account.username, secret_ref, account.status],
        )?;
        Ok(())
    }

    pub fn update_account_username(&self, id: &str, username: Option<&str>) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE accounts SET username = ?2 WHERE id = ?1",
            params![id, username],
        )?;
        Ok(())
    }

    pub fn get_account(&self, id: &str) -> Result<StoredAccount> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT id, provider, label, endpoint, username, status, secret_ref FROM accounts WHERE id = ?1",
                [id],
                |row| {
                    Ok(StoredAccount {
                        account: Account {
                            id: row.get(0)?,
                            provider: row.get(1)?,
                            label: row.get(2)?,
                            endpoint: row.get(3)?,
                            username: row.get(4)?,
                            status: row.get(5)?,
                        },
                        secret_ref: row.get(6)?,
                    })
                },
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => {
                    NimbusError::Validation("找不到这个存储源".into())
                }
                other => other.into(),
            })
    }

    pub fn delete_account(&self, id: &str) -> Result<StoredAccount> {
        let stored = self.get_account(id)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM metadata_cache WHERE file_id IN (SELECT id FROM media_files WHERE account_id=?1)", [id])?;
        transaction.execute("DELETE FROM media_files WHERE account_id = ?1", [id])?;
        transaction.execute("DELETE FROM media_sources WHERE account_id = ?1", [id])?;
        // Reading positions are keyed by account, not by a library row, so nothing cascades to them.
        transaction.execute("DELETE FROM reading_progress WHERE account_id = ?1", [id])?;
        transaction.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
        transaction.commit()?;
        Ok(stored)
    }

    pub fn list_media_files(&self) -> Result<Vec<MediaFile>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, account_id, remote_path, cloud_path, display_name, size, etag, mime_type, (SELECT sf.source_id FROM source_files sf WHERE sf.file_id=media_files.id AND sf.present=1 ORDER BY sf.source_id LIMIT 1), COALESCE((SELECT ms.kind FROM media_sources ms JOIN source_files sf ON sf.source_id=ms.id WHERE sf.file_id=media_files.id AND sf.present=1 ORDER BY sf.source_id LIMIT 1), media_files.media_kind), COALESCE((SELECT group_concat(source_id,'|') FROM source_files WHERE file_id=media_files.id AND present=1),'')
             FROM media_files WHERE scan_state = 'ready' AND EXISTS (SELECT 1 FROM source_files WHERE file_id=media_files.id AND present=1) ORDER BY display_name COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(MediaFile {
                id: row.get(0)?,
                account_id: row.get(1)?,
                remote_path: row.get(2)?,
                cloud_path: row.get(3)?,
                display_name: row.get(4)?,
                size: row.get(5)?,
                etag: row.get(6)?,
                mime_type: row.get(7)?,
                source_id: row.get(8)?,
                source_ids: row
                    .get::<_, String>(10)?
                    .split('|')
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .collect(),
                media_kind: row.get(9)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn get_media_file(&self, id: &str) -> Result<MediaFile> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT id, account_id, remote_path, cloud_path, display_name, size, etag, mime_type, (SELECT sf.source_id FROM source_files sf WHERE sf.file_id=media_files.id AND sf.present=1 ORDER BY sf.source_id LIMIT 1), COALESCE((SELECT ms.kind FROM media_sources ms JOIN source_files sf ON sf.source_id=ms.id WHERE sf.file_id=media_files.id AND sf.present=1 ORDER BY sf.source_id LIMIT 1), media_files.media_kind), COALESCE((SELECT group_concat(source_id,'|') FROM source_files WHERE file_id=media_files.id AND present=1),'')
                 FROM media_files WHERE id = ?1 AND scan_state = 'ready'",
                [id],
                |row| {
                    Ok(MediaFile {
                        id: row.get(0)?,
                        account_id: row.get(1)?,
                        remote_path: row.get(2)?,
                        cloud_path: row.get(3)?,
                        display_name: row.get(4)?,
                        size: row.get(5)?,
                        etag: row.get(6)?,
                        mime_type: row.get(7)?,
                        source_id: row.get(8)?,
                    source_ids: row.get::<_,String>(10)?.split('|').filter(|id| !id.is_empty()).map(str::to_owned).collect(),
                        media_kind: row.get(9)?,
                    })
                },
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => {
                    NimbusError::Validation("媒体文件不存在或尚未完成扫描".into())
                }
                other => other.into(),
            })
    }

    pub fn ensure_media_file(
        &self,
        account_id: &str,
        remote_path: &str,
        cloud_path: Option<&str>,
        name: &str,
        media_kind: &str,
        size: u64,
    ) -> Result<String> {
        use rusqlite::OptionalExtension;
        let connection = self.connection.lock();
        let cp = cloud_path.unwrap_or(remote_path);
        // The playable address identifies the file; the display path is only a fallback, so a
        // file replaced at the same path (a new Baidu fs_id) never resolves to the old one.
        let by_remote = connection
            .query_row(
                "SELECT id FROM media_files WHERE account_id = ?1 AND remote_path = ?2",
                rusqlite::params![account_id, remote_path],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(id) = by_remote {
            connection.execute(
                "UPDATE media_files SET cloud_path = ?1, display_name = ?2 WHERE id = ?3",
                rusqlite::params![cp, name, id],
            )?;
            return Ok(id);
        }
        let by_cloud = connection
            .query_row(
                "SELECT id FROM media_files WHERE account_id = ?1 AND cloud_path = ?2 ORDER BY rowid LIMIT 1",
                rusqlite::params![account_id, cp],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(id) = by_cloud {
            connection.execute(
                "UPDATE media_files SET remote_path = ?1, display_name = ?2 WHERE id = ?3",
                rusqlite::params![remote_path, name, id],
            )?;
            return Ok(id);
        }
        let file_id = uuid::Uuid::new_v4().to_string();
        connection.execute(
            "INSERT INTO media_files (id, account_id, remote_path, cloud_path, display_name, size, etag, mime_type, scan_state, source_id, media_kind)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, 'ready', NULL, ?7)
             ON CONFLICT(account_id, remote_path) DO UPDATE SET display_name = excluded.display_name, cloud_path = excluded.cloud_path",
            rusqlite::params![file_id, account_id, remote_path, cp, name, size, media_kind],
        )?;
        Ok(file_id)
    }
}

fn write_playlist_items(
    transaction: &rusqlite::Transaction<'_>,
    playlist_id: &str,
    file_ids: &[String],
) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    let mut position = 0_i64;
    for file_id in file_ids {
        if !seen.insert(file_id.as_str()) {
            continue;
        }
        // Songs that are no longer in the library are skipped rather than failing the save.
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO playlist_items (playlist_id, file_id, position)
             SELECT ?1, id, ?3 FROM media_files WHERE id = ?2",
            params![playlist_id, file_id, position],
        )?;
        position += inserted as i64;
    }
    Ok(())
}

/// WebDAV paths used to be stored as the server spelled them ("/dav/%E7%94%B5%E5%BD%B1/"); they are
/// now decoded and relative to the account's address ("/电影"), as Files shows them. Media folders,
/// library files and reading memory move to the new paths in place, keeping their ids, progress and
/// pages. Files played from Files before had only a bare server path as address; they get a URL.
fn migrate_webdav_paths(connection: &Connection) -> Result<()> {
    let transaction = connection.unchecked_transaction()?;
    let rows = |sql: &str, key: &str| -> Result<Vec<(String, String, String)>> {
        let mut statement = transaction.prepare(sql)?;
        let rows = statement.query_map([key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    };
    let accounts = rows(
        "SELECT id, endpoint, '' FROM accounts WHERE provider = ?1",
        "webdav",
    )?;
    for (account, endpoint, _) in accounts {
        let Ok(base) = crate::webdav::validated_url(&endpoint) else {
            continue;
        };
        let mut kept = std::collections::HashSet::new();
        let mut moved = Vec::new();
        for (id, kind, root) in rows(
            "SELECT id, kind, remote_root FROM media_sources WHERE account_id = ?1 ORDER BY created_at, rowid",
            &account,
        )? {
            let Some((_, root)) = crate::webdav::locate_saved(&base, &root) else {
                continue;
            };
            if kept.insert((kind, root.clone())) {
                moved.push((id, root));
            } else {
                // "/dav/电影" and "/dav/电影/" were added as two folders; they are one now.
                transaction.execute("DELETE FROM source_files WHERE source_id = ?1", [&id])?;
                transaction.execute("DELETE FROM media_sources WHERE id = ?1", [&id])?;
            }
        }
        for (id, root) in moved {
            transaction.execute(
                "UPDATE OR IGNORE media_sources SET remote_root = ?1 WHERE id = ?2",
                params![root, id],
            )?;
        }
        for (id, remote, _) in rows(
            "SELECT id, remote_path, '' FROM media_files WHERE account_id = ?1",
            &account,
        )? {
            let Some((url, path)) = crate::webdav::locate_saved(&base, &remote) else {
                continue;
            };
            let updated = transaction.execute(
                "UPDATE OR IGNORE media_files SET remote_path = ?1, cloud_path = ?2 WHERE id = ?3",
                params![url.as_str(), path, id],
            )?;
            if updated == 0 && !remote.contains("://") {
                // Broken by playing it from Files, then scanned again as a new row: that row is
                // the file now, so it takes over the resume position, playlists and manual match.
                use rusqlite::OptionalExtension;
                let Some(file) = transaction
                    .query_row(
                        "SELECT id FROM media_files WHERE account_id = ?1 AND remote_path = ?2",
                        params![account, url.as_str()],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                else {
                    continue;
                };
                for table in ["playback_progress", "playlist_items", "metadata_overrides"] {
                    transaction.execute(
                        &format!("UPDATE OR IGNORE {table} SET file_id = ?1 WHERE file_id = ?2"),
                        params![file, id],
                    )?;
                }
                transaction.execute("DELETE FROM media_files WHERE id = ?1", [&id])?;
            }
        }
        for (key, path, entry) in rows(
            "SELECT doc_key, path, entry_id FROM reading_progress WHERE account_id = ?1",
            &account,
        )? {
            let saved = if entry.contains("://") { entry } else { path };
            let Some((_, path)) = crate::webdav::locate_saved(&base, &saved) else {
                continue;
            };
            transaction.execute(
                "UPDATE OR IGNORE reading_progress SET doc_key = ?1, path = ?2 WHERE doc_key = ?3",
                params![format!("{account}:{path}"), path, key],
            )?;
        }
    }
    transaction.execute_batch("PRAGMA user_version = 7;")?;
    transaction.commit()?;
    Ok(())
}

fn reading_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReadingProgress> {
    Ok(ReadingProgress {
        doc_key: row.get(0)?,
        account_id: row.get(1)?,
        path: row.get(2)?,
        entry_id: row.get(3)?,
        name: row.get(4)?,
        size: row.get(5)?,
        page: row.get(6)?,
        page_count: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

#[cfg(test)]
#[path = "tests/store.rs"]
mod tests;
