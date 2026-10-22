use super::*;
use std::os::unix::net::UnixListener;

fn server(lines: Vec<Value>) -> (PathBuf, std::thread::JoinHandle<()>) {
    let path = std::env::temp_dir().join(format!("nimbus-ipc-{}.sock", uuid::Uuid::new_v4()));
    let listener = UnixListener::bind(&path).unwrap();
    let thread = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut input = String::new();
        reader.read_line(&mut input).unwrap();
        let mut stream = stream;
        for line in lines {
            writeln!(stream, "{line}").unwrap();
        }
    });
    (path, thread)
}
#[test]
fn command_error_is_not_reported_as_success() {
    let (path, thread) = server(vec![json!({"request_id":1,"error":"invalid parameter"})]);
    assert!(send(&path, json!(["set_property", "sid", -1])).is_err());
    thread.join().unwrap();
    fs::remove_file(path).unwrap();
}
#[test]
fn unrelated_events_are_ignored_until_matching_reply() {
    let (path, thread) = server(vec![
        json!({"event":"file-loaded"}),
        json!({"request_id":99,"error":"success"}),
        json!({"request_id":1,"error":"success","data":42}),
    ]);
    assert_eq!(query(&path, "time-pos").unwrap(), json!(42));
    thread.join().unwrap();
    fs::remove_file(path).unwrap();
}
#[test]
fn closed_connection_returns_error() {
    let (path, thread) = server(vec![]);
    assert!(send(&path, json!(["stop"])).is_err());
    thread.join().unwrap();
    fs::remove_file(path).unwrap();
}
#[test]
fn regenerated_subtitle_replaces_only_its_own_track() {
    let tracks = json!([
        {"id": 1, "type": "video"},
        {"id": 1, "type": "sub", "external": false},
        {"id": 2, "type": "sub", "external": true, "external-filename": "/s/a.srt"},
        {"id": 3, "type": "sub", "external": true, "external-filename": "/s/b.srt"},
        {"id": 1, "type": "audio", "external-filename": "/s/a.srt"},
    ]);
    assert_eq!(subtitle_tracks_from(&tracks, "/s/a.srt"), vec![2]);
    assert!(subtitle_tracks_from(&Value::Null, "/s/a.srt").is_empty());
}
#[test]
fn cancelled_open_does_not_wait_for_timeout() {
    assert_eq!(
        wait_for_media(Path::new("/nonexistent"), "test", &AtomicU64::new(2), 1),
        MediaWait::Cancelled
    );
}
#[test]
fn a_replaced_open_is_not_reported_as_a_timeout() {
    assert!(is_cancelled(&cancelled()));
    assert!(!is_cancelled(&NimbusError::Validation(
        "媒体连接超时，请检查网盘网络后重试".into()
    )));
    assert_eq!(cancelled().to_string(), OPEN_CANCELLED);
}
#[test]
fn folder_playlist_is_dropped_when_another_file_plays() {
    let file = |id: &str| crate::model::MediaFile {
        id: id.into(),
        account_id: "local".into(),
        remote_path: format!("/music/{id}.flac"),
        cloud_path: None,
        display_name: format!("{id}.flac"),
        size: 0,
        etag: None,
        mime_type: None,
        source_id: None,
        source_ids: Vec::new(),
        media_kind: Some("music".into()),
    };
    let player = PlayerController::new();
    player.set_playlist(vec![file("a"), file("b")]);
    player.keep_playlist_for("b");
    assert_eq!(player.playlist().len(), 2);
    player.keep_playlist_for("library-film");
    assert!(player.playlist().is_empty());
}

#[tokio::test]
async fn old_subtitle_job_never_targets_new_file() {
    let player = PlayerController::new();
    *player.current_file_id.lock() = Some("new-file".into());
    assert!(!player
        .add_subtitle_for_file("old-file", "/tmp/unused.srt")
        .await
        .unwrap());
    assert_eq!(player.current_file_id().as_deref(), Some("new-file"));
}

#[test]
fn found_chinese_subtitles_replace_only_a_foreign_or_missing_track() {
    let tracks = |selected: Value| json!([{"id": 1, "type": "video"}, selected]);
    assert!(should_switch_to(&json!([{"id": 1, "type": "video"}]), "chi"));
    assert!(should_switch_to(&json!([{"id": 1, "type": "video"}]), "eng"));
    assert!(should_switch_to(&tracks(json!({"id": 2, "type": "sub", "selected": true, "lang": "eng"})), "chi"));
    assert!(!should_switch_to(&tracks(json!({"id": 2, "type": "sub", "selected": true, "lang": "chi"})), "chi"));
    assert!(!should_switch_to(&tracks(json!({"id": 2, "type": "sub", "selected": true, "lang": "zh-Hant"})), "chi"));
    assert!(!should_switch_to(&tracks(json!({"id": 2, "type": "sub", "selected": true, "title": "AI 字幕"})), "chi"));
    assert!(!should_switch_to(&tracks(json!({"id": 2, "type": "sub", "selected": true, "lang": "eng"})), "eng"));
}
