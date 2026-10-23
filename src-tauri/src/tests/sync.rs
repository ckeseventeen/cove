use super::*;
use crate::{
    model::{Account, MediaFile, MediaSource, ReadingProgress},
    store::Store,
};

const DAV: &str = "webdav:https://dav.example.com/dav";

/// One computer: a library with the same WebDAV account as the others, under its own id.
struct Computer {
    store: Store,
    directory: PathBuf,
    account: String,
}

impl Computer {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("cove-sync-test-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&directory.join("library.db")).unwrap();
        store.ensure_local_account().unwrap();
        let account = uuid::Uuid::new_v4().to_string();
        store
            .insert_account(
                &Account {
                    id: account.clone(),
                    provider: "webdav".into(),
                    label: "NAS".into(),
                    endpoint: "https://dav.example.com/dav".into(),
                    username: Some("me".into()),
                    status: "ok".into(),
                },
                &format!("account:{account}"),
            )
            .unwrap();
        sql(&store, &format!("UPDATE accounts SET sync_identity = '{DAV}' WHERE id = '{account}'"));
        Self { store, directory, account }
    }

    fn source(&self, root: &str) -> MediaSource {
        let source = MediaSource {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: self.account.clone(),
            kind: "movie".into(),
            remote_root: root.into(),
            label: "影视".into(),
            last_scan_at: None,
        };
        self.store.insert_media_source(&source).unwrap();
        source
    }

    /// Scans `names` into a folder; returns their file ids here.
    fn scan(&self, source: &MediaSource, names: &[&str]) -> Vec<String> {
        let files: Vec<MediaFile> = names
            .iter()
            .map(|name| MediaFile {
                id: uuid::Uuid::new_v4().to_string(),
                account_id: self.account.clone(),
                remote_path: format!("https://dav.example.com/dav{}/{name}", source.remote_root),
                cloud_path: Some(format!("{}/{name}", source.remote_root)),
                display_name: (*name).into(),
                size: 10,
                etag: None,
                mime_type: None,
                source_id: None,
                source_ids: Vec::new(),
                media_kind: None,
            })
            .collect();
        self.store.replace_source_files(source, &files, true).unwrap();
        names.iter().map(|name| self.file(&format!("{}/{name}", source.remote_root))).collect()
    }

    fn file(&self, path: &str) -> String {
        self.store
            .transaction(|t| {
                Ok(t.query_row(
                    "SELECT id FROM media_files WHERE cloud_path = ?1",
                    [path],
                    |row| row.get(0),
                )?)
            })
            .unwrap()
    }

    fn export(&self, device: &str) -> SyncFile {
        self.store.transaction(|t| export(t, device, device)).unwrap()
    }

    fn apply(&self, file: &SyncFile) -> Applied {
        self.store.transaction(|t| apply(t, file)).unwrap()
    }

    fn number(&self, query: &str) -> i64 {
        self.store.transaction(|t| Ok(t.query_row(query, [], |row| row.get(0))?)).unwrap()
    }

    fn position(&self, file_id: &str) -> Option<f64> {
        self.store.playback_progress(file_id).unwrap().map(|(position, _)| position)
    }
}

impl Drop for Computer {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn sql(store: &Store, statement: &str) {
    store
        .transaction(|t| {
            t.execute_batch(statement)?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn newer_progress_wins_in_both_directions() {
    let (mac, pc) = (Computer::new(), Computer::new());
    let mac_files = mac.scan(&mac.source("/电影"), &["a.mkv"]);
    let pc_files = pc.scan(&pc.source("/电影"), &["a.mkv"]);
    mac.store.save_playback_progress(&mac_files[0], 300.0, 6000.0, 1.0).unwrap();
    sql(&mac.store, "UPDATE playback_progress SET updated_at = 1000");

    assert!(pc.apply(&mac.export("mac")).changed);
    assert_eq!(pc.position(&pc_files[0]), Some(300.0));

    // Watched further on the PC: the Mac takes it, and the Mac's older file changes nothing.
    pc.store.save_playback_progress(&pc_files[0], 900.0, 6000.0, 1.25).unwrap();
    sql(&pc.store, "UPDATE playback_progress SET updated_at = 2000");
    assert!(!pc.apply(&mac.export("mac")).changed);
    assert_eq!(pc.position(&pc_files[0]), Some(900.0));
    assert!(mac.apply(&pc.export("pc")).changed);
    assert_eq!(mac.position(&mac_files[0]), Some(900.0));
    assert_eq!(mac.number("SELECT updated_at FROM playback_progress"), 2000);

    // Merging again changes nothing: the computers agree.
    assert!(!mac.apply(&pc.export("pc")).changed);
    assert!(!pc.apply(&mac.export("mac")).changed);
}

#[test]
fn media_folders_are_added_and_removed_everywhere() {
    let (mac, pc) = (Computer::new(), Computer::new());
    let source = mac.source("/音乐");
    let applied = pc.apply(&mac.export("mac"));
    assert_eq!(applied.new_sources.len(), 1);
    assert_eq!(pc.number("SELECT COUNT(*) FROM media_sources WHERE remote_root = '/音乐'"), 1);
    // Not added twice.
    assert!(pc.apply(&mac.export("mac")).new_sources.is_empty());

    mac.store.delete_media_source(&source.id).unwrap();
    sql(&mac.store, "UPDATE sync_deleted SET deleted_at = unixepoch() + 10");
    assert!(pc.apply(&mac.export("mac")).changed);
    assert_eq!(pc.number("SELECT COUNT(*) FROM media_sources WHERE remote_root = '/音乐'"), 0);
    // And the PC's own file no longer brings it back to the Mac.
    assert!(mac.apply(&pc.export("pc")).new_sources.is_empty());
}

#[test]
fn a_folder_added_again_after_removal_comes_back() {
    let (mac, pc) = (Computer::new(), Computer::new());
    let source = mac.source("/课程");
    sql(&mac.store, "UPDATE media_sources SET created_at = 50");
    pc.apply(&mac.export("mac"));
    mac.store.delete_media_source(&source.id).unwrap();
    sql(&mac.store, "UPDATE sync_deleted SET deleted_at = 100");
    pc.apply(&mac.export("mac"));
    assert_eq!(pc.number("SELECT COUNT(*) FROM media_sources WHERE remote_root = '/课程'"), 0);
    mac.source("/课程");
    assert_eq!(pc.apply(&mac.export("mac")).new_sources.len(), 1);
}

#[test]
fn marking_unwatched_clears_progress_on_the_other_computer() {
    let (mac, pc) = (Computer::new(), Computer::new());
    let mac_files = mac.scan(&mac.source("/剧集"), &["e1.mkv"]);
    let pc_files = pc.scan(&pc.source("/剧集"), &["e1.mkv"]);
    mac.store.mark_watched(&mac_files, true).unwrap();
    sql(&mac.store, "UPDATE playback_progress SET updated_at = 1000");
    pc.apply(&mac.export("mac"));
    assert_eq!(pc.position(&pc_files[0]), Some(0.0));

    mac.store.mark_watched(&mac_files, false).unwrap();
    assert!(pc.apply(&mac.export("mac")).changed);
    assert_eq!(pc.position(&pc_files[0]), None);
}

#[test]
fn playlists_follow_their_songs_and_deletion() {
    let (mac, pc) = (Computer::new(), Computer::new());
    let mac_files = mac.scan(&mac.source("/音乐"), &["1.flac", "2.flac", "3.flac"]);
    let pc_source = pc.source("/音乐");
    pc.scan(&pc_source, &["1.flac", "3.flac"]);
    mac.store
        .create_playlist("list", "通勤", &[mac_files[2].clone(), mac_files[0].clone(), mac_files[1].clone()])
        .unwrap();
    sql(&mac.store, "UPDATE playlists SET updated_at = 1000");

    pc.apply(&mac.export("mac"));
    let playlist = pc.store.list_playlists().unwrap().remove(0);
    assert_eq!(playlist.name, "通勤");
    assert_eq!(playlist.file_ids, vec![pc.file("/音乐/3.flac"), pc.file("/音乐/1.flac")]);
    // A song not scanned here yet: the PC's copy stays older, so the Mac's complete one is kept…
    assert!(!mac.apply(&pc.export("pc")).changed);
    assert_eq!(mac.store.list_playlists().unwrap()[0].file_ids.len(), 3);
    // …and fills in once the song is scanned here.
    pc.scan(&pc_source, &["1.flac", "2.flac", "3.flac"]);
    pc.apply(&mac.export("mac"));
    assert_eq!(pc.store.list_playlists().unwrap()[0].file_ids.len(), 3);

    mac.store.delete_playlist("list").unwrap();
    pc.apply(&mac.export("mac"));
    assert!(pc.store.list_playlists().unwrap().is_empty());
}

#[test]
fn reading_progress_and_play_counts_merge() {
    let (mac, pc) = (Computer::new(), Computer::new());
    let mac_files = mac.scan(&mac.source("/音乐"), &["1.flac"]);
    let pc_files = pc.scan(&pc.source("/音乐"), &["1.flac"]);
    for _ in 0..3 {
        mac.store.record_play(&mac_files[0]).unwrap();
    }
    pc.store.record_play(&pc_files[0]).unwrap();
    pc.apply(&mac.export("mac"));
    assert_eq!(pc.number("SELECT play_count FROM play_history"), 3);

    let progress = mac
        .store
        .touch_reading_document(&ReadingProgress {
            doc_key: format!("{}:/书/a.pdf", mac.account),
            account_id: mac.account.clone(),
            path: "/书/a.pdf".into(),
            entry_id: String::new(),
            name: "a.pdf".into(),
            size: 1,
            page: 0,
            page_count: 0,
            updated_at: 0,
        })
        .unwrap();
    mac.store.save_reading_page(&progress.doc_key, 42, 300).unwrap();
    pc.apply(&mac.export("mac"));
    let read = pc.store.reading_progress(&format!("{}:/书/a.pdf", pc.account)).unwrap().unwrap();
    assert_eq!((read.page, read.page_count), (42, 300));
}

#[test]
fn records_for_accounts_this_computer_lacks_are_skipped() {
    let mac = Computer::new();
    let pc = Computer::new();
    sql(&pc.store, "UPDATE accounts SET sync_identity = 'webdav:https://other.example.com/dav' WHERE provider = 'webdav'");
    let files = mac.scan(&mac.source("/电影"), &["a.mkv"]);
    mac.store.save_playback_progress(&files[0], 300.0, 6000.0, 1.0).unwrap();
    let applied = pc.apply(&mac.export("mac"));
    assert!(!applied.changed && applied.new_sources.is_empty());
}

#[test]
fn local_disks_are_not_shared() {
    let mac = Computer::new();
    mac.store
        .insert_media_source(&MediaSource {
            id: "local-movies".into(),
            account_id: "local".into(),
            kind: "movie".into(),
            remote_root: "/Users/me/影视".into(),
            label: "影视".into(),
            last_scan_at: None,
        })
        .unwrap();
    assert!(mac.export("mac").sources.is_empty());
}

#[test]
fn sync_files_round_trip_through_json() {
    let mac = Computer::new();
    let files = mac.scan(&mac.source("/电影"), &["a.mkv"]);
    mac.store.save_playback_progress(&files[0], 300.0, 6000.0, 1.0).unwrap();
    let file = mac.export("mac");
    let parsed: SyncFile = serde_json::from_slice(&serde_json::to_vec(&file).unwrap()).unwrap();
    assert_eq!(parsed, file);
    // Fields a later version adds are ignored; missing lists read as empty.
    let older: SyncFile = serde_json::from_str(r#"{"version":1,"device":"x","deviceName":"X","extra":true}"#).unwrap();
    assert!(older.sources.is_empty());
}
