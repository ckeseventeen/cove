//! System Now Playing: Control Center, media keys, AirPods and Touch Bar controls.
use std::{
    ffi::{c_char, c_int, CString},
    sync::OnceLock,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::player::PlayerStatus;

unsafe extern "C" {
    fn nimbus_now_playing_install(callback: extern "C" fn(c_int, f64));
    fn nimbus_now_playing_update(
        title: *const c_char,
        artist: *const c_char,
        album: *const c_char,
        duration: f64,
        elapsed: f64,
        playing: bool,
        video: bool,
    );
    fn nimbus_now_playing_set_artwork(bytes: *const u8, length: usize);
    fn nimbus_now_playing_clear();
}

const REMOTE_PLAY: c_int = 1;
const REMOTE_PAUSE: c_int = 2;
const REMOTE_TOGGLE: c_int = 3;
const REMOTE_NEXT: c_int = 4;
const REMOTE_PREVIOUS: c_int = 5;
const REMOTE_SEEK: c_int = 6;

static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: Mutex<Published> = parking_lot::const_mutex(Published::new());

/// Display details supplied by the window that knows the track (music metadata or episode title).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub file_id: String,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    pub artwork_url: Option<String>,
}

struct Published {
    file_id: Option<String>,
    title: String,
    video: bool,
    info: Option<TrackInfo>,
    /// (file id, artwork url) of the image currently handed to the system.
    artwork: Option<(String, String)>,
    revision: u64,
    published_revision: u64,
    playing: bool,
    duration: f64,
    elapsed: f64,
    published_at: Option<Instant>,
}

impl Published {
    const fn new() -> Self {
        Self {
            file_id: None,
            title: String::new(),
            video: false,
            info: None,
            artwork: None,
            revision: 0,
            published_revision: 0,
            playing: false,
            duration: 0.0,
            elapsed: 0.0,
            published_at: None,
        }
    }
}

pub fn install(app: AppHandle) {
    if APP.set(app).is_ok() {
        unsafe { nimbus_now_playing_install(on_remote_command) };
    }
}

/// Publish player progress. `describe` is only called when a new file starts.
pub fn sync(status: &PlayerStatus, describe: impl FnOnce(&str) -> (String, bool)) {
    let mut state = STATE.lock();
    let Some(file_id) = status.file_id.as_deref() else {
        if state.file_id.take().is_some() {
            *state = Published::new();
            unsafe { nimbus_now_playing_clear() };
        }
        return;
    };
    if state.file_id.as_deref() != Some(file_id) {
        let (title, video) = describe(file_id);
        let info = state.info.take().filter(|info| info.file_id == file_id);
        let artwork = state.artwork.take().filter(|(owner, _)| owner == file_id);
        if artwork.is_none() {
            unsafe { nimbus_now_playing_set_artwork(std::ptr::null(), 0) };
        }
        *state = Published::new();
        state.file_id = Some(file_id.to_owned());
        state.title = title;
        state.video = video;
        state.info = info;
        state.artwork = artwork;
        state.revision = 1;
    }
    let playing = status.running && !status.paused && !status.eof_reached;
    let expected = match (state.playing, state.published_at) {
        (true, Some(at)) => state.elapsed + at.elapsed().as_secs_f64() * status.speed.max(0.25),
        _ => state.elapsed,
    };
    let drifted = (status.position - expected).abs() > 1.5;
    if state.published_revision == state.revision
        && state.playing == playing
        && (state.duration - status.duration).abs() < 0.5
        && !drifted
    {
        return;
    }
    state.playing = playing;
    state.duration = status.duration;
    state.elapsed = status.position;
    state.published_at = Some(Instant::now());
    state.published_revision = state.revision;
    publish(&state);
}

/// Attach richer metadata (and artwork) to the current or about-to-start file.
pub fn set_info(info: TrackInfo) {
    let artwork = {
        let mut state = STATE.lock();
        if state.info.as_ref() == Some(&info) {
            return;
        }
        let artwork = info.artwork_url.clone().filter(|url| {
            state.artwork.as_ref() != Some(&(info.file_id.clone(), url.clone()))
                && (url.starts_with("https://") || url.starts_with("http://"))
        });
        if state.file_id.as_deref() == Some(info.file_id.as_str()) {
            state.revision += 1;
        }
        state.info = Some(info.clone());
        artwork
    };
    if let Some(url) = artwork {
        tauri::async_runtime::spawn(load_artwork(info.file_id, url));
    } else {
        republish();
    }
}

async fn load_artwork(file_id: String, url: String) {
    let response = crate::http_client::metadata_http()
        .get(&url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .and_then(|response| response.error_for_status());
    let Ok(bytes) = (match response {
        Ok(response) => response.bytes().await,
        Err(error) => Err(error),
    }) else {
        return;
    };
    let mut state = STATE.lock();
    if state.file_id.as_deref() != Some(file_id.as_str())
        && state.info.as_ref().map(|info| info.file_id.as_str()) != Some(file_id.as_str())
    {
        return;
    }
    state.artwork = Some((file_id.clone(), url));
    state.revision += 1;
    unsafe { nimbus_now_playing_set_artwork(bytes.as_ptr(), bytes.len()) };
    if state.file_id.as_deref() == Some(file_id.as_str()) {
        state.published_revision = state.revision;
        publish(&state);
    }
}

fn republish() {
    let mut state = STATE.lock();
    if state.file_id.is_some() && state.published_at.is_some() {
        state.published_revision = state.revision;
        publish(&state);
    }
}

fn publish(state: &Published) {
    let info = state
        .info
        .as_ref()
        .filter(|info| state.file_id.as_deref() == Some(info.file_id.as_str()));
    let title = info
        .map(|info| info.title.as_str())
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(&state.title);
    let text = |value: &str| CString::new(value.replace('\0', "")).unwrap_or_default();
    let title = text(title);
    let artist = text(info.map(|info| info.artist.as_str()).unwrap_or_default());
    let album = text(info.map(|info| info.album.as_str()).unwrap_or_default());
    let elapsed = state.elapsed
        + if state.playing {
            state
                .published_at
                .map(|at| at.elapsed().as_secs_f64())
                .unwrap_or_default()
        } else {
            0.0
        };
    unsafe {
        nimbus_now_playing_update(
            title.as_ptr(),
            artist.as_ptr(),
            album.as_ptr(),
            state.duration,
            elapsed,
            state.playing,
            state.video,
        );
    }
}

extern "C" fn on_remote_command(command: c_int, value: f64) {
    let Some(app) = APP.get().cloned() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let state = app.state::<crate::AppState>();
        let action = match command {
            REMOTE_PLAY => "play",
            REMOTE_PAUSE => "pause",
            REMOTE_TOGGLE => "play_pause",
            REMOTE_SEEK => "seek_absolute",
            REMOTE_NEXT => {
                let _ = app.emit("menu-action", "cove.next");
                return;
            }
            REMOTE_PREVIOUS => {
                let _ = app.emit("menu-action", "cove.previous");
                return;
            }
            _ => return,
        };
        let value = (command == REMOTE_SEEK).then_some(value);
        if state.player.control(action.into(), value).await.is_ok() {
            let snapshot = state.player.status().await;
            let _ = app.emit("nimbus-player-state", &snapshot);
        }
    });
}

#[tauri::command]
pub(crate) fn now_playing_info(info: TrackInfo) {
    set_info(info);
}
