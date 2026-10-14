use super::*;
use uuid::Uuid;

struct Fixture {
    store: Store,
    directory: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("nimbus-regression-{}", Uuid::new_v4()));
        let store = Store::open(&directory.join("library.db")).unwrap();
        store.ensure_local_account().unwrap();
        Self { store, directory }
    }
    fn source(&self, id: &str) -> MediaSource {
        let source = MediaSource {
            id: id.into(),
            account_id: "local".into(),
            kind: "movie".into(),
            remote_root: format!("/media/{id}"),
            label: id.into(),
            last_scan_at: None,
        };
        self.store.insert_media_source(&source).unwrap();
        source
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
fn file(name: &str) -> MediaFile {
    MediaFile {
        id: Uuid::new_v4().to_string(),
        account_id: "local".into(),
        remote_path: format!("/media/{name}"),
        cloud_path: Some(format!("/media/{name}")),
        display_name: name.into(),
        size: 10,
        etag: None,
        mime_type: None,
        source_id: None,
        source_ids: Vec::new(),
        media_kind: None,
    }
}

#[test]
fn partial_scan_preserves_unseen_files_and_progress() {
    let f = Fixture::new();
    let source = f.source("parent");
    let a = file("a.mkv");
    let b = file("b.mkv");
    f.store
        .replace_source_files(&source, &[a.clone(), b.clone()], true)
        .unwrap();
    f.store
        .save_playback_progress(&b.id, 30.0, 100.0, 1.0)
        .unwrap();
    f.store.replace_source_files(&source, &[a], false).unwrap();
    assert_eq!(f.store.list_media_files().unwrap().len(), 2);
    assert_eq!(f.store.playback_progress(&b.id).unwrap(), Some((30.0, 1.0)));
}
#[test]
fn complete_scan_hides_missing_but_restores_same_identity_and_progress() {
    let f = Fixture::new();
    let source = f.source("parent");
    let b = file("b.mkv");
    f.store
        .replace_source_files(&source, &[b.clone()], true)
        .unwrap();
    f.store
        .save_playback_progress(&b.id, 30.0, 100.0, 1.0)
        .unwrap();
    f.store.replace_source_files(&source, &[], true).unwrap();
    assert!(f.store.list_media_files().unwrap().is_empty());
    f.store
        .replace_source_files(&source, &[file("b.mkv")], true)
        .unwrap();
    assert_eq!(f.store.list_media_files().unwrap()[0].id, b.id);
    assert_eq!(f.store.playback_progress(&b.id).unwrap(), Some((30.0, 1.0)));
}
#[test]
fn overlapping_sources_keep_membership_after_removal() {
    let f = Fixture::new();
    let parent = f.source("parent");
    let child = f.source("child");
    let a = file("a.mkv");
    f.store
        .replace_source_files(&parent, &[a.clone()], true)
        .unwrap();
    f.store
        .replace_source_files(&child, &[file("a.mkv")], true)
        .unwrap();
    let files = f.store.list_media_files().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source_ids.len(), 2);
    f.store.delete_media_source(&child.id).unwrap();
    let files = f.store.list_media_files().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source_id.as_deref(), Some("parent"));
    assert_eq!(files[0].id, a.id);
}
#[test]
fn removed_source_cannot_commit_late_scan() {
    let f = Fixture::new();
    let source = f.source("source");
    f.store.delete_media_source(&source.id).unwrap();
    assert!(f
        .store
        .replace_source_files(&source, &[file("a.mkv")], true)
        .is_err());
    assert!(f.store.list_media_files().unwrap().is_empty());
}
#[test]
fn account_removal_cleans_metadata() {
    let f = Fixture::new();
    let source = f.source("source");
    let a = file("a.mkv");
    f.store
        .replace_source_files(&source, &[a.clone()], true)
        .unwrap();
    f.store.save_metadata(&a.id, "movie-v4", "{}").unwrap();
    f.store.delete_account("local").unwrap();
    assert!(f
        .store
        .cached_metadata(&a.id, "movie-v4")
        .unwrap()
        .is_none());
}
#[test]
fn migration_is_repeatable_and_retains_progress() {
    let f = Fixture::new();
    let source = f.source("source");
    let a = file("a.mkv");
    f.store
        .replace_source_files(&source, &[a.clone()], true)
        .unwrap();
    f.store
        .save_playback_progress(&a.id, 42.0, 100.0, 1.25)
        .unwrap();
    let reopened = Store::open(&f.directory.join("library.db")).unwrap();
    assert_eq!(reopened.list_media_files().unwrap().len(), 1);
    assert_eq!(
        reopened.playback_progress(&a.id).unwrap(),
        Some((42.0, 1.25))
    );
}
#[test]
fn empty_partial_scan_does_not_record_success_timestamp() {
    let f = Fixture::new();
    let source = f.source("source");
    f.store.replace_source_files(&source, &[], false).unwrap();
    assert_eq!(
        f.store.get_media_source(&source.id).unwrap().last_scan_at,
        None
    );
}

#[test]
fn local_file_management_to_library_and_resume_flow() {
    let f = Fixture::new();
    let folder =
        crate::local_storage::create_folder(f.directory.to_str().unwrap(), "个人文件").unwrap();
    let path = std::path::Path::new(&folder).join("示例电影.2024.mp4");
    std::fs::write(&path, b"synthetic media index fixture").unwrap();
    let destination =
        crate::local_storage::create_folder(f.directory.to_str().unwrap(), "影音库").unwrap();
    crate::local_storage::copy_entry(path.to_str().unwrap(), &destination).unwrap();
    assert_eq!(crate::local_storage::browse(&destination).unwrap().len(), 1);
    let mut source = f.source("flow");
    source.remote_root = destination;
    let (files, scan) =
        crate::local_storage::scan_root("local", &source.remote_root, "movie", 100).unwrap();
    assert!(!scan.truncated);
    f.store.replace_source_files(&source, &files, true).unwrap();
    let indexed = f.store.list_media_files().unwrap();
    assert_eq!(indexed.len(), 1);
    let id = &indexed[0].id;
    f.store
        .save_playback_progress(id, 32.0, 100.0, 1.0)
        .unwrap();
    f.store.replace_source_files(&source, &[], false).unwrap();
    assert_eq!(f.store.playback_progress(id).unwrap(), Some((32.0, 1.0)));
    f.store.delete_media_source(&source.id).unwrap();
    assert!(f.store.list_media_files().unwrap().is_empty());
    assert!(path.exists());
}

#[test]
fn older_libraries_accept_document_folders_and_keep_memberships() {
    let directory = std::env::temp_dir().join(format!("cove-migrate-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("library.db");
    {
        let store = Store::open(&path).unwrap();
        store.ensure_local_account().unwrap();
        let connection = store.connection.lock();
        // Recreate the pre-document schema, as an existing installation has it.
        connection
            .execute_batch(
                "PRAGMA foreign_keys = OFF;
                 DROP TABLE media_sources;
                 CREATE TABLE media_sources (
                   id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                   kind TEXT NOT NULL CHECK (kind IN ('movie', 'music')), remote_root TEXT NOT NULL,
                   label TEXT NOT NULL, last_scan_at INTEGER, created_at INTEGER NOT NULL,
                   UNIQUE (account_id, kind, remote_root));
                 DROP TABLE reading_progress;
                 PRAGMA user_version = 3;
                 PRAGMA foreign_keys = ON;
                 INSERT INTO media_sources (id, account_id, kind, remote_root, label, created_at)
                   VALUES ('old', 'local', 'movie', '/media/old', 'Old', unixepoch());",
            )
            .unwrap();
    }
    let store = Store::open(&path).unwrap();
    let old = store.get_media_source("old").unwrap();
    store
        .replace_source_files(&old, &[file("Kept.mkv")], true)
        .unwrap();
    let documents = MediaSource {
        id: "docs".into(),
        account_id: "local".into(),
        kind: "document".into(),
        remote_root: "/media/docs".into(),
        label: "Docs".into(),
        last_scan_at: None,
    };
    store.insert_media_source(&documents).unwrap();
    assert_eq!(store.list_media_sources().unwrap().len(), 2);
    assert_eq!(store.list_media_files().unwrap().len(), 1);
    // Removing a folder still cascades through the rebuilt table.
    store.delete_media_source("old").unwrap();
    assert!(store.list_media_files().unwrap().is_empty());
    drop(store);
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn reading_progress_survives_reopening_and_keeps_the_page() {
    let fixture = Fixture::new();
    let document = crate::model::ReadingProgress {
        doc_key: "local:/books/a.pdf".into(),
        account_id: "local".into(),
        path: "/books/a.pdf".into(),
        entry_id: "/books/a.pdf".into(),
        name: "a.pdf".into(),
        size: 10,
        page: 0,
        page_count: 0,
        updated_at: 0,
    };
    assert_eq!(fixture.store.touch_reading_document(&document).unwrap().page, 0);
    fixture.store.save_reading_page(&document.doc_key, 41, 300).unwrap();
    let reopened = fixture.store.touch_reading_document(&document).unwrap();
    assert_eq!((reopened.page, reopened.page_count), (41, 300));
    assert_eq!(fixture.store.list_reading_progress(10).unwrap().len(), 1);
}

#[test]
fn webdav_libraries_move_to_decoded_paths_and_keep_progress() {
    let f = Fixture::new();
    let account = crate::model::Account {
        id: "dav".into(),
        provider: "webdav".into(),
        label: "NAS".into(),
        endpoint: "https://nas.example.com/dav".into(),
        username: Some("me".into()),
        status: "ok".into(),
    };
    f.store.insert_account(&account, "account:dav").unwrap();
    // As an older version stored them: encoded server paths, one folder added twice.
    let source = |id: &str, root: &str| {
        let source = MediaSource {
            id: id.into(),
            account_id: "dav".into(),
            kind: "movie".into(),
            remote_root: root.into(),
            label: id.into(),
            last_scan_at: None,
        };
        f.store.insert_media_source(&source).unwrap();
        source
    };
    let movies = source("movies", "/dav/%E7%94%B5%E5%BD%B1/");
    let twin = source("twin", "/dav/%E7%94%B5%E5%BD%B1");
    let episode = MediaFile {
        account_id: "dav".into(),
        remote_path: "https://nas.example.com/dav/%E7%94%B5%E5%BD%B1/%E7%AC%AC01%E9%9B%86.mkv".into(),
        cloud_path: Some("/dav/%E7%94%B5%E5%BD%B1/%E7%AC%AC01%E9%9B%86.mkv".into()),
        ..file("第01集.mkv")
    };
    f.store.replace_source_files(&movies, &[episode.clone()], true).unwrap();
    f.store.replace_source_files(&twin, &[episode.clone()], true).unwrap();
    f.store.save_playback_progress(&episode.id, 1200.0, 3000.0, 1.0).unwrap();
    // Played from Files before the fix: a bare server path as its address.
    let played = f
        .store
        .ensure_media_file("dav", "/dav/M/a%20b.mkv", Some("/dav/M/a%20b.mkv"), "a b.mkv", "movie", 1)
        .unwrap();
    let document = crate::model::ReadingProgress {
        doc_key: "dav:/dav/%E4%B9%A6/a.pdf".into(),
        account_id: "dav".into(),
        path: "/dav/%E4%B9%A6/a.pdf".into(),
        entry_id: "https://nas.example.com/dav/%E4%B9%A6/a.pdf".into(),
        name: "a.pdf".into(),
        size: 10,
        page: 0,
        page_count: 0,
        updated_at: 0,
    };
    f.store.touch_reading_document(&document).unwrap();
    f.store.save_reading_page(&document.doc_key, 30, 100).unwrap();
    f.store
        .connection
        .lock()
        .execute_batch("PRAGMA user_version = 6;")
        .unwrap();

    let store = Store::open(&f.directory.join("library.db")).unwrap();
    let sources = store.list_media_sources().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!((sources[0].id.as_str(), sources[0].remote_root.as_str()), ("movies", "/电影"));
    let migrated = store.get_media_file(&episode.id).unwrap();
    assert_eq!(migrated.cloud_path.as_deref(), Some("/电影/第01集.mkv"));
    assert_eq!(migrated.remote_path, episode.remote_path);
    assert_eq!(store.playback_progress(&episode.id).unwrap(), Some((1200.0, 1.0)));
    assert_eq!(store.list_media_files().unwrap().len(), 1);
    let repaired = store.get_media_file(&played).unwrap();
    assert_eq!(repaired.remote_path, "https://nas.example.com/dav/M/a%20b.mkv");
    assert_eq!(repaired.cloud_path.as_deref(), Some("/M/a b.mkv"));
    assert_eq!(store.reading_progress("dav:/书/a.pdf").unwrap().map(|p| p.page), Some(30));
    assert!(store.reading_progress(&document.doc_key).unwrap().is_none());
}

#[test]
fn webdav_migration_keeps_the_first_folder_and_the_progress_of_broken_copies() {
    let f = Fixture::new();
    let account = crate::model::Account {
        id: "nas".into(),
        provider: "webdav".into(),
        label: "NAS".into(),
        endpoint: "https://nas.example.com".into(),
        username: Some("me".into()),
        status: "ok".into(),
    };
    f.store.insert_account(&account, "account:nas").unwrap();
    let source = |id: &str, root: &str| {
        let source = MediaSource {
            id: id.into(),
            account_id: "nas".into(),
            kind: "movie".into(),
            remote_root: root.into(),
            label: id.into(),
            last_scan_at: None,
        };
        f.store.insert_media_source(&source).unwrap();
        source
    };
    // At the server's root the older spelling of the newer folder is already the new path.
    let first = source("first", "/Movies/");
    source("second", "/Movies");
    let scanned = |remote: &str| MediaFile {
        account_id: "nas".into(),
        remote_path: remote.into(),
        cloud_path: Some("/Movies/a%20b.mkv".into()),
        ..file("a b.mkv")
    };
    let original = scanned("https://nas.example.com/Movies/a%20b.mkv");
    f.store.replace_source_files(&first, &[original.clone()], true).unwrap();
    f.store.save_playback_progress(&original.id, 1200.0, 3000.0, 1.0).unwrap();
    f.store.create_playlist("list", "片单", &[original.id.clone()]).unwrap();
    f.store.save_metadata_override(&original.id, "Heat").unwrap();
    // Played from Files before the fix, which broke its address, then scanned again.
    f.store
        .ensure_media_file("nas", "/Movies/a%20b.mkv", Some("/Movies/a%20b.mkv"), "a b.mkv", "movie", 1)
        .unwrap();
    let rescanned = scanned("https://nas.example.com/Movies/a%20b.mkv");
    f.store.replace_source_files(&first, &[rescanned.clone()], true).unwrap();
    assert_eq!(f.store.playback_progress(&rescanned.id).unwrap(), None);
    f.store
        .connection
        .lock()
        .execute_batch("PRAGMA user_version = 6;")
        .unwrap();

    let store = Store::open(&f.directory.join("library.db")).unwrap();
    let sources = store.list_media_sources().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!((sources[0].id.as_str(), sources[0].remote_root.as_str()), ("first", "/Movies"));
    let files = store.list_media_files().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].id, rescanned.id);
    assert_eq!(files[0].cloud_path.as_deref(), Some("/Movies/a b.mkv"));
    assert!(store.get_media_file(&original.id).is_err());
    assert_eq!(store.playback_progress(&rescanned.id).unwrap(), Some((1200.0, 1.0)));
    assert_eq!(store.list_playlists().unwrap()[0].file_ids, [rescanned.id.clone()]);
    assert_eq!(store.metadata_override(&rescanned.id).unwrap().as_deref(), Some("Heat"));
}

#[test]
fn playlists_keep_order_skip_missing_songs_and_cascade() {
    let fixture = Fixture::new();
    let source = fixture.source("songs");
    let songs = [file("A.flac"), file("B.flac"), file("C.flac")];
    fixture.store.replace_source_files(&source, &songs, true).unwrap();
    let ids: Vec<String> = fixture.store.list_media_files().unwrap().into_iter().map(|file| file.id).collect();
    let wanted = vec![ids[2].clone(), ids[0].clone(), "missing".to_owned(), ids[2].clone()];
    fixture.store.create_playlist("p1", "通勤", &wanted).unwrap();
    let playlists = fixture.store.list_playlists().unwrap();
    assert_eq!(playlists.len(), 1);
    assert_eq!(playlists[0].file_ids, vec![ids[2].clone(), ids[0].clone()]);

    fixture.store.set_playlist_items("p1", &[ids[1].clone(), ids[2].clone()]).unwrap();
    fixture.store.rename_playlist("p1", "周末").unwrap();
    let playlist = &fixture.store.list_playlists().unwrap()[0];
    assert_eq!((playlist.name.as_str(), playlist.file_ids.len()), ("周末", 2));
    assert!(fixture.store.rename_playlist("nope", "x").is_err());

    fixture.store.delete_playlist("p1").unwrap();
    assert!(fixture.store.list_playlists().unwrap().is_empty());
    let connection = fixture.store.connection.lock();
    let orphans: i64 = connection
        .query_row("SELECT count(*) FROM playlist_items", [], |row| row.get(0))
        .unwrap();
    assert_eq!(orphans, 0);
}

#[test]
fn ensure_media_file_prefers_playable_address_over_display_path() {
    let fixture = Fixture::new();
    let old = fixture
        .store
        .ensure_media_file("local", "baidu://1", Some("/影视/a.mkv"), "a.mkv", "movie", 1)
        .unwrap();
    // The same display path, reached by its old address again, keeps its identity.
    let again = fixture
        .store
        .ensure_media_file("local", "baidu://1", Some("/影视/a.mkv"), "a.mkv", "movie", 1)
        .unwrap();
    assert_eq!(again, old);
    // A file already known by another address is never confused with the old one.
    let other = fixture
        .store
        .ensure_media_file("local", "baidu://2", Some("/影视/b.mkv"), "b.mkv", "movie", 1)
        .unwrap();
    let replaced = fixture
        .store
        .ensure_media_file("local", "baidu://2", Some("/影视/a.mkv"), "a.mkv", "movie", 1)
        .unwrap();
    assert_eq!(replaced, other);
    assert_eq!(
        fixture.store.get_media_file(&replaced).unwrap().remote_path,
        "baidu://2"
    );
    // Only the display path matches: the row follows the file to its new address.
    let moved = fixture
        .store
        .ensure_media_file("local", "baidu://3", Some("/影视/a.mkv"), "a.mkv", "movie", 1)
        .unwrap();
    assert_eq!(moved, old);
    assert_eq!(
        fixture.store.get_media_file(&moved).unwrap().remote_path,
        "baidu://3"
    );
}
