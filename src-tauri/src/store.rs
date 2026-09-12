use std::{fs, path::Path};

use rusqlite::{params, Connection};

use crate::{
    error::{NimbusError, Result},
    model::{Account, MediaFile, MediaSource, StoredAccount},
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
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self {
            connection: parking_lot::Mutex::new(connection),
        })
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
    pub fn recent_playback(&self) -> Result<Vec<serde_json::Value>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare("SELECT p.file_id,p.position_sec,p.duration_sec,p.updated_at FROM playback_progress p WHERE EXISTS(SELECT 1 FROM source_files sf WHERE sf.file_id=p.file_id AND sf.present=1) ORDER BY p.updated_at DESC LIMIT 12")?;
        let rows = statement.query_map([], |row| Ok(serde_json::json!({"fileId":row.get::<_,String>(0)?, "position":row.get::<_,f64>(1)?, "duration":row.get::<_,f64>(2)?, "updatedAt":row.get::<_,i64>(3)?})))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn cached_movies(&self) -> Result<std::collections::HashMap<String, serde_json::Value>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT file_id,payload FROM metadata_cache WHERE kind='movie-v4'")?;
        let rows = statement.query_map([], |row| {
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
        let position = if duration > 0.0 && position / duration >= 0.95 {
            0.0
        } else {
            position.max(0.0)
        };
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
        transaction.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
        transaction.commit()?;
        Ok(stored)
    }

    pub fn list_media_files(&self) -> Result<Vec<MediaFile>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, account_id, remote_path, cloud_path, display_name, size, etag, mime_type, (SELECT sf.source_id FROM source_files sf WHERE sf.file_id=media_files.id AND sf.present=1 ORDER BY sf.source_id LIMIT 1), (SELECT ms.kind FROM media_sources ms JOIN source_files sf ON sf.source_id=ms.id WHERE sf.file_id=media_files.id AND sf.present=1 ORDER BY sf.source_id LIMIT 1), COALESCE((SELECT group_concat(source_id,'|') FROM source_files WHERE file_id=media_files.id AND present=1),'')
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
                "SELECT id, account_id, remote_path, cloud_path, display_name, size, etag, mime_type, (SELECT sf.source_id FROM source_files sf WHERE sf.file_id=media_files.id AND sf.present=1 ORDER BY sf.source_id LIMIT 1), (SELECT ms.kind FROM media_sources ms JOIN source_files sf ON sf.source_id=ms.id WHERE sf.file_id=media_files.id AND sf.present=1 ORDER BY sf.source_id LIMIT 1), COALESCE((SELECT group_concat(source_id,'|') FROM source_files WHERE file_id=media_files.id AND present=1),'')
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
        let connection = self.connection.lock();
        let cp = cloud_path.unwrap_or(remote_path);
        if let Ok(id) = connection.query_row(
            "SELECT id FROM media_files WHERE account_id = ?1 AND (remote_path = ?2 OR (cloud_path = ?3 AND cloud_path IS NOT NULL))",
            rusqlite::params![account_id, remote_path, cp],
            |row| row.get::<_, String>(0),
        ) {
            let _ = connection.execute(
                "UPDATE media_files SET remote_path = ?1, cloud_path = ?2, display_name = ?3 WHERE id = ?4",
                rusqlite::params![remote_path, cp, name, id],
            );
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

#[cfg(test)]
#[path = "tests/store.rs"]
mod tests;
