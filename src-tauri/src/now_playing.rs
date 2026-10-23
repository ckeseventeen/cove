//! System Now Playing: on macOS Control Center, media keys, AirPods and Touch Bar controls; on
//! Windows the media keys and the player in the volume flyout (System Media Transport Controls).
use std::{
    ffi::c_int,
    sync::OnceLock,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::player::PlayerStatus;

const REMOTE_PLAY: c_int = 1;
const REMOTE_PAUSE: c_int = 2;
const REMOTE_TOGGLE: c_int = 3;
const REMOTE_NEXT: c_int = 4;
const REMOTE_PREVIOUS: c_int = 5;
const REMOTE_SEEK: c_int = 6;

/// What a track shows in the system's player.
struct Shown<'a> {
    title: &'a str,
    artist: &'a str,
    album: &'a str,
    duration: f64,
    elapsed: f64,
    playing: bool,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    video: bool,
}

#[cfg(target_os = "macos")]
mod system {
    use std::ffi::{c_char, c_int, CString};

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

    extern "C" fn on_remote_command(command: c_int, value: f64) {
        super::remote_command(command, value);
    }

    pub fn install() {
        unsafe { nimbus_now_playing_install(on_remote_command) };
    }

    pub fn clear() {
        unsafe { nimbus_now_playing_clear() };
    }

    pub fn set_artwork(bytes: Option<&[u8]>) {
        match bytes {
            Some(bytes) => unsafe { nimbus_now_playing_set_artwork(bytes.as_ptr(), bytes.len()) },
            None => unsafe { nimbus_now_playing_set_artwork(std::ptr::null(), 0) },
        }
    }

    pub fn update(shown: &super::Shown) {
        let text = |value: &str| CString::new(value.replace('\0', "")).unwrap_or_default();
        let (title, artist, album) = (text(shown.title), text(shown.artist), text(shown.album));
        unsafe {
            nimbus_now_playing_update(
                title.as_ptr(),
                artist.as_ptr(),
                album.as_ptr(),
                shown.duration,
                shown.elapsed,
                shown.playing,
                shown.video,
            );
        }
    }
}

#[cfg(windows)]
mod system {
    use std::{cell::RefCell, time::Duration};

    use parking_lot::Mutex;
    use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig};
    use tauri::Manager;

    thread_local! {
        /// The controls live on the main thread, which owns the window they belong to.
        static CONTROLS: RefCell<Option<MediaControls>> = const { RefCell::new(None) };
    }
    /// The cover, as a file the system reads it from.
    static ARTWORK: Mutex<Option<String>> = Mutex::new(None);

    fn on_main(change: impl FnOnce(&mut MediaControls) + Send + 'static) {
        let Some(app) = super::APP.get() else {
            return;
        };
        let _ = app.run_on_main_thread(move || {
            CONTROLS.with(|slot| {
                if let Some(controls) = slot.borrow_mut().as_mut() {
                    change(controls);
                }
            })
        });
    }

    pub fn install() {
        let Some(app) = super::APP.get() else {
            return;
        };
        let Some(hwnd) = app.get_webview_window("main").and_then(|window| window.hwnd().ok()) else {
            return;
        };
        let hwnd = hwnd.0 as usize;
        let _ = app.run_on_main_thread(move || {
            let config = PlatformConfig { dbus_name: "cove", display_name: "Cove", hwnd: Some(hwnd as *mut std::ffi::c_void) };
            let Ok(mut controls) = MediaControls::new(config) else {
                return;
            };
            let attached = controls.attach(|event| match event {
                MediaControlEvent::Play => super::remote_command(super::REMOTE_PLAY, 0.0),
                MediaControlEvent::Pause | MediaControlEvent::Stop => super::remote_command(super::REMOTE_PAUSE, 0.0),
                MediaControlEvent::Toggle => super::remote_command(super::REMOTE_TOGGLE, 0.0),
                MediaControlEvent::Next => super::remote_command(super::REMOTE_NEXT, 0.0),
                MediaControlEvent::Previous => super::remote_command(super::REMOTE_PREVIOUS, 0.0),
                MediaControlEvent::SetPosition(MediaPosition(position)) => {
                    super::remote_command(super::REMOTE_SEEK, position.as_secs_f64())
                }
                _ => {}
            });
            if attached.is_ok() {
                CONTROLS.with(|slot| *slot.borrow_mut() = Some(controls));
            }
        });
    }

    pub fn clear() {
        *ARTWORK.lock() = None;
        on_main(|controls| {
            let _ = controls.set_playback(MediaPlayback::Stopped);
        });
    }

    pub fn set_artwork(bytes: Option<&[u8]>) {
        let Some(bytes) = bytes else {
            *ARTWORK.lock() = None;
            return;
        };
        // A new name for each cover, so the system does not show a cached earlier one; Windows
        // reads the image by its extension.
        let extension = if bytes.starts_with(b"\x89PNG") { "png" } else { "jpg" };
        let path = std::env::temp_dir().join(format!("cove-artwork-{:x}.{extension}", md5::compute(bytes)));
        if std::fs::write(&path, bytes).is_ok() {
            *ARTWORK.lock() = Some(format!("file://{}", path.display()));
        }
    }

    pub fn update(shown: &super::Shown) {
        let (title, artist, album) = (shown.title.to_owned(), shown.artist.to_owned(), shown.album.to_owned());
        let (duration, elapsed, playing) = (shown.duration, shown.elapsed, shown.playing);
        let cover = ARTWORK.lock().clone();
        on_main(move |controls| {
            let given = |value: &str| Some(value).filter(|value| !value.trim().is_empty()).map(str::to_owned);
            let (artist, album) = (given(&artist), given(&album));
            let _ = controls.set_metadata(MediaMetadata {
                title: Some(title.as_str()),
                artist: artist.as_deref(),
                album: album.as_deref(),
                cover_url: cover.as_deref(),
                duration: (duration > 0.0).then(|| Duration::from_secs_f64(duration)),
            });
            let progress = Some(MediaPosition(Duration::from_secs_f64(elapsed.max(0.0))));
            let _ = controls.set_playback(if playing { MediaPlayback::Playing { progress } } else { MediaPlayback::Paused { progress } });
        });
    }
}

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
        system::install();
    }
}

/// Publish player progress. `describe` is only called when a new file starts.
pub fn sync(status: &PlayerStatus, describe: impl FnOnce(&str) -> (String, bool)) {
    let mut state = STATE.lock();
    let Some(file_id) = status.file_id.as_deref() else {
        if state.file_id.take().is_some() {
            *state = Published::new();
            system::clear();
        }
        return;
    };
    if state.file_id.as_deref() != Some(file_id) {
        let (title, video) = describe(file_id);
        let info = state.info.take().filter(|info| info.file_id == file_id);
        let artwork = state.artwork.take().filter(|(owner, _)| owner == file_id);
        if artwork.is_none() {
            system::set_artwork(None);
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
    system::set_artwork(Some(&bytes));
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
    let elapsed = state.elapsed
        + if state.playing {
            state
                .published_at
                .map(|at| at.elapsed().as_secs_f64())
                .unwrap_or_default()
        } else {
            0.0
        };
    system::update(&Shown {
        title,
        artist: info.map(|info| info.artist.as_str()).unwrap_or_default(),
        album: info.map(|info| info.album.as_str()).unwrap_or_default(),
        duration: state.duration,
        elapsed,
        playing: state.playing,
        video: state.video,
    });
}

/// A button pressed in the system's player, or a media key.
fn remote_command(command: c_int, value: f64) {
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
