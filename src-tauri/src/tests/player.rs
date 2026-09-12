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
fn cancelled_open_does_not_wait_for_timeout() {
    assert!(!wait_for_media(
        Path::new("/nonexistent"),
        "test",
        &AtomicU64::new(2),
        1
    ));
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
