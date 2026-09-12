use parking_lot::Mutex;
use std::{
    ffi::{c_char, c_int, c_void, CString},
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::WebviewWindow;

use crate::error::{NimbusError, Result};

#[derive(Clone)]
pub struct PlayerController {
    socket_path: PathBuf,
    gate: Arc<tokio::sync::Mutex<()>>,
    generation: Arc<AtomicU64>,
    snapshot: Arc<Mutex<Option<PlayerStatus>>>,
    current_file_id: Arc<Mutex<Option<String>>>,
    native_handle: Arc<Mutex<Option<usize>>>,
    native_view: Arc<Mutex<Option<usize>>>,
    playlist: Arc<Mutex<Vec<crate::model::MediaFile>>>,
}

#[repr(C)]
struct MpvHandle {
    _private: [u8; 0],
}

#[link(name = "mpv")]
unsafe extern "C" {
    fn mpv_terminate_destroy(ctx: *mut MpvHandle);
    fn mpv_create() -> *mut MpvHandle;
    fn mpv_initialize(ctx: *mut MpvHandle) -> c_int;
    fn mpv_set_option_string(
        ctx: *mut MpvHandle,
        name: *const c_char,
        data: *const c_char,
    ) -> c_int;
    fn nimbus_mpv_view_create(window: *mut c_void, controls_height: f64) -> *mut c_void;
    fn nimbus_mpv_view_attach(view: *mut c_void, ctx: *mut MpvHandle) -> c_int;
    fn nimbus_mpv_view_set_hidden(view: *mut c_void, hidden: bool);
    fn nimbus_mpv_view_set_controls_height(view: *mut c_void, controls_height: f64);
    fn nimbus_attach_controls_window(parent: *mut c_void, child: *mut c_void);
    fn nimbus_detach_controls_window(child: *mut c_void);
    fn nimbus_mpv_view_clear(view: *mut c_void);
}

pub fn attach_controls_window(parent: &WebviewWindow, child: &WebviewWindow) -> Result<()> {
    let parent_window = parent
        .ns_window()
        .map_err(|error| NimbusError::Internal(format!("无法取得播放器主窗口：{error}")))?
        as usize;
    let child_window = child
        .ns_window()
        .map_err(|error| NimbusError::Internal(format!("无法取得播放器控制窗口：{error}")))?
        as usize;
    parent
        .run_on_main_thread(move || unsafe {
            nimbus_attach_controls_window(
                parent_window as *mut c_void,
                child_window as *mut c_void,
            );
        })
        .map_err(|error| NimbusError::Internal(format!("无法显示播放器控制层：{error}")))
}

pub fn detach_controls_window(child: &WebviewWindow) -> Result<()> {
    let child_window = child
        .ns_window()
        .map_err(|error| NimbusError::Internal(format!("无法取得播放器控制窗口：{error}")))?
        as usize;
    child
        .run_on_main_thread(move || unsafe {
            nimbus_detach_controls_window(child_window as *mut c_void);
        })
        .map_err(|error| NimbusError::Internal(format!("无法收起播放器控制层：{error}")))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerTrack {
    pub id: i64,
    pub kind: String,
    pub title: String,
    pub language: String,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStatus {
    pub file_id: Option<String>,
    pub error: Option<String>,
    pub running: bool,
    pub paused: bool,
    pub eof_reached: bool,
    pub position: f64,
    pub duration: f64,
    pub speed: f64,
    pub volume: f64,
    pub tracks: Vec<PlayerTrack>,
}

impl PlayerController {
    pub fn new() -> Self {
        Self {
            gate: Arc::new(tokio::sync::Mutex::new(())),
            generation: Arc::new(AtomicU64::new(0)),
            snapshot: Arc::new(Mutex::new(None)),
            socket_path: PathBuf::from(format!("/tmp/nimbus-mpv-{}.sock", std::process::id())),
            current_file_id: Arc::new(Mutex::new(None)),
            native_handle: Arc::new(Mutex::new(None)),
            native_view: Arc::new(Mutex::new(None)),
            playlist: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn set_playlist(&self, list: Vec<crate::model::MediaFile>) {
        *self.playlist.lock() = list;
    }

    pub fn playlist(&self) -> Vec<crate::model::MediaFile> {
        self.playlist.lock().clone()
    }

    async fn send_subtitle(&self, path: &str, title: Option<&str>) -> Result<()> {
        let command = json!(["sub-add", path, "select", title.unwrap_or("AI 字幕")]);
        let socket = self.socket_path.clone();
        tokio::task::spawn_blocking(move || send(&socket, command))
            .await
            .map_err(|error| NimbusError::Internal(error.to_string()))??;
        Ok(())
    }
    pub async fn add_subtitle(&self, path: &str, title: Option<&str>) -> Result<()> {
        let _permit = self.gate.lock().await;
        self.send_subtitle(path, title).await
    }
    pub async fn add_subtitle_for_file(&self, file_id: &str, path: &str) -> Result<bool> {
        let _permit = self.gate.lock().await;
        if self.current_file_id().as_deref() != Some(file_id) {
            return Ok(false);
        }
        self.send_subtitle(path, Some("AI 字幕")).await?;
        Ok(true)
    }

    pub fn cancel_pending_open(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn open(
        &self,
        window: WebviewWindow,
        file_id: String,
        url: String,
        title: String,
        start_position: f64,
        speed: f64,
        show_video: bool,
    ) -> Result<()> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _guard = self.gate.lock().await;
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err(NimbusError::Validation("已取消旧播放请求".into()));
        }
        *self.current_file_id.lock() = None;
        *self.snapshot.lock() = None;
        let view = self.ensure_native_view(&window).await?;
        unsafe {
            nimbus_mpv_view_clear(view as *mut c_void);
        }
        self.set_view_visible(&window, show_video).await?;
        let socket = self.socket_path.clone();
        let current_file_id = Arc::clone(&self.current_file_id);
        let native_handle = Arc::clone(&self.native_handle);
        let active_generation = Arc::clone(&self.generation);
        tokio::task::spawn_blocking(move || {
            let log_path = PathBuf::from("/tmp/nimbus-mpv.log");
            let _ = fs::write(
                &log_path,
                format!(
                    "Nimbus embedded libmpv opening {title}\nIPC: {}\nNSView: 0x{view:x}\n",
                    socket.display()
                ),
            );
            let mut handle_guard = native_handle.lock();
            if handle_guard.is_none() {
                let _ = fs::remove_file(&socket);
                let handle = create_embedded_player(view, &socket, &log_path)?;
                *handle_guard = Some(handle as usize);
            }
            drop(handle_guard);
            wait_for_socket(&socket)?;
            send(&socket, json!(["loadfile", &url, "replace"]))?;
            if !wait_for_media(&socket, &url, &active_generation, generation) {
                let _ = send(&socket, json!(["stop"]));
                return Err(NimbusError::Validation(
                    "媒体连接超时，请检查网盘网络后重试".into(),
                ));
            }
            send(
                &socket,
                json!(["set_property", "speed", speed.clamp(0.25, 4.0)]),
            )?;
            if start_position > 1.0 {
                send(&socket, json!(["seek", start_position, "absolute+exact"]))?;
            }
            send(&socket, json!(["set_property", "pause", false]))?;
            if generation != active_generation.load(Ordering::SeqCst) {
                let _ = send(&socket, json!(["stop"]));
                return Err(NimbusError::Validation("播放已取消".into()));
            }
            *current_file_id.lock() = Some(file_id);
            Ok(())
        })
        .await
        .map_err(|error| NimbusError::Internal(format!("播放器任务失败：{error}")))?
    }

    async fn ensure_native_view(&self, window: &WebviewWindow) -> Result<usize> {
        if let Some(view) = *self.native_view.lock() {
            return Ok(view);
        }
        let native_window = window
            .ns_window()
            .map_err(|error| NimbusError::Internal(format!("无法取得 Nimbus 原生窗口：{error}")))?
            as usize;
        let (sender, receiver) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let result = (|| {
                    let view = unsafe { nimbus_mpv_view_create(native_window as *mut c_void, 0.0) };
                    if view.is_null() {
                        Err("无法创建 OpenGL 视频视图".to_owned())
                    } else {
                        Ok(view as usize)
                    }
                })();
                let _ = sender.send(result);
            })
            .map_err(|error| NimbusError::Internal(format!("无法创建视频视图：{error}")))?;
        let view =
            tokio::task::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(3)))
                .await
                .map_err(|e| NimbusError::Internal(e.to_string()))?
                .map_err(|_| NimbusError::Internal("创建视频视图超时".into()))?
                .map_err(NimbusError::Internal)?;
        *self.native_view.lock() = Some(view);
        Ok(view)
    }

    pub async fn set_view_visible(&self, window: &WebviewWindow, visible: bool) -> Result<()> {
        let Some(view) = *self.native_view.lock() else {
            return Ok(());
        };
        window
            .run_on_main_thread(move || {
                unsafe { nimbus_mpv_view_set_hidden(view as *mut c_void, !visible) };
            })
            .map_err(|error| NimbusError::Internal(format!("无法更新视频视图：{error}")))
    }

    pub async fn set_controls_height(&self, window: &WebviewWindow, height: f64) -> Result<()> {
        let Some(view) = *self.native_view.lock() else {
            return Ok(());
        };
        window
            .run_on_main_thread(move || unsafe {
                nimbus_mpv_view_set_controls_height(view as *mut c_void, height.clamp(0.0, 260.0));
            })
            .map_err(|error| NimbusError::Internal(format!("无法调整视频视图：{error}")))
    }

    pub fn current_file_id(&self) -> Option<String> {
        self.current_file_id.lock().clone()
    }

    pub async fn control(&self, action: String, value: Option<f64>) -> Result<()> {
        if action == "stop" {
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
        let _guard = self.gate.lock().await;
        let is_stop = action == "stop";
        let command = match action.as_str() {
            "play_pause" => json!(["cycle", "pause"]),
            "seek_absolute" => {
                json!(["seek", value.unwrap_or_default().max(0.0), "absolute+exact"])
            }
            "seek" => json!(["seek", value.unwrap_or_default(), "relative+exact"]),
            "speed" => json!([
                "set_property",
                "speed",
                value.unwrap_or(1.0).clamp(0.25, 4.0)
            ]),
            "volume" => json!([
                "set_property",
                "volume",
                value.unwrap_or(100.0).clamp(0.0, 100.0)
            ]),
            "fullscreen" => json!(["cycle", "fullscreen"]),
            "subtitle" => {
                if value.unwrap_or(-1.0) < 0.0 {
                    json!(["set_property", "sid", "no"])
                } else {
                    json!(["set_property", "sid", value.unwrap() as i64])
                }
            }
            "audio" => json!(["set_property", "aid", value.unwrap_or(-1.0) as i64]),
            "stop" => json!(["stop"]),
            _ => return Err(NimbusError::Validation("不支持的播放器命令".into())),
        };
        let socket = self.socket_path.clone();
        let result = tokio::task::spawn_blocking(move || send(&socket, command))
            .await
            .map_err(|error| NimbusError::Internal(format!("播放器任务失败：{error}")))?;
        if is_stop && result.is_ok() {
            *self.current_file_id.lock() = None;
            *self.snapshot.lock() = None;
            if let Some(view) = *self.native_view.lock() {
                unsafe {
                    nimbus_mpv_view_clear(view as *mut c_void);
                }
            }
        }
        result
    }

    pub fn cached_status(&self) -> PlayerStatus {
        self.snapshot.lock().clone().unwrap_or_else(empty_status)
    }

    pub async fn status(&self) -> PlayerStatus {
        let _guard = self.gate.lock().await;
        let file_id = self.current_file_id();
        if file_id.is_none() {
            return empty_status();
        }
        let socket = self.socket_path.clone();
        let result = tokio::task::spawn_blocking(move || read_status(&socket)).await;
        let mut status = match result {
            Ok(Ok(status)) => status,
            result => {
                let mut status = self.cached_status();
                status.running = false;
                status.error = Some(match result {
                    Ok(Err(error)) => error.to_string(),
                    Err(error) => error.to_string(),
                    _ => unreachable!(),
                });
                status
            }
        };
        status.file_id = file_id;
        *self.snapshot.lock() = Some(status.clone());
        status
    }
}

fn create_embedded_player(view: usize, socket: &Path, log_path: &Path) -> Result<*mut MpvHandle> {
    let handle = unsafe { mpv_create() };
    if handle.is_null() {
        return Err(NimbusError::Internal("libmpv 初始化失败".into()));
    }
    let socket_value = socket.to_string_lossy().into_owned();
    let log_value = log_path.to_string_lossy().into_owned();
    for (name, value) in [
        ("config", "no"),
        ("terminal", "no"),
        ("osc", "no"),
        ("idle", "yes"),
        ("keep-open", "yes"),
        ("hwdec", "auto-safe"),
        ("background-color", "#000000"),
        ("audio-display", "no"),
        ("keepaspect", "yes"),
        ("cache", "yes"),
        ("cache-on-disk", "yes"),
        ("cache-pause", "no"),
        ("demuxer-max-bytes", "512MiB"),
        ("demuxer-max-back-bytes", "128MiB"),
        ("input-ipc-server", socket_value.as_str()),
        ("log-file", log_value.as_str()),
    ] {
        let name = CString::new(name).expect("static option name");
        let value = CString::new(value)
            .map_err(|_| NimbusError::Internal("libmpv 选项包含无效字符".into()))?;
        let result = unsafe { mpv_set_option_string(handle, name.as_ptr(), value.as_ptr()) };
        if result < 0 {
            unsafe {
                mpv_terminate_destroy(handle);
            }
            return Err(NimbusError::Internal(format!(
                "libmpv 设置选项失败（错误 {result}）"
            )));
        }
    }
    let result = unsafe { mpv_initialize(handle) };
    if result < 0 {
        unsafe {
            mpv_terminate_destroy(handle);
        }
        return Err(NimbusError::Internal(format!(
            "libmpv 启动失败（错误 {result}）"
        )));
    }
    let result = unsafe { nimbus_mpv_view_attach(view as *mut c_void, handle) };
    if result < 0 {
        unsafe {
            mpv_terminate_destroy(handle);
        }
        return Err(NimbusError::Internal(format!(
            "libmpv OpenGL 渲染器初始化失败（错误 {result}）"
        )));
    }
    Ok(handle)
}

fn wait_for_socket(path: &Path) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if path.exists() && UnixStream::connect(path).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(NimbusError::Internal("libmpv 控制通道启动超时".into()))
}

fn wait_for_media(path: &Path, expected: &str, generation: &AtomicU64, current: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(75);
    while Instant::now() < deadline {
        if generation.load(Ordering::SeqCst) != current {
            return false;
        }
        if query(path, "path")
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .as_deref()
            == Some(expected)
            && query(path, "duration")
                .ok()
                .and_then(|value| value.as_f64())
                .unwrap_or_default()
                > 0.0
        {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn connect(path: &Path) -> Result<UnixStream> {
    let stream =
        UnixStream::connect(path).map_err(|_| NimbusError::Validation("播放器尚未启动".into()))?;
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    Ok(stream)
}

fn send(path: &Path, command: Value) -> Result<()> {
    request(path, command).map(|_| ())
}
fn request(path: &Path, command: Value) -> Result<Value> {
    let mut stream = connect(path)?;
    writeln!(stream, "{}", json!({"command": command, "request_id": 1}))?;
    let mut reader = BufReader::new(stream);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if Instant::now() >= deadline {
            return Err(NimbusError::Validation("播放器命令等待超时".into()));
        }
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(NimbusError::Validation("播放器连接已关闭".into()));
        }
        let response: Value = serde_json::from_str(&line)?;
        if response.get("request_id").and_then(Value::as_i64) != Some(1) {
            continue;
        }
        if response.get("error").and_then(Value::as_str) != Some("success") {
            return Err(NimbusError::Validation(format!(
                "播放器命令失败：{}",
                response["error"]
            )));
        }
        return Ok(response.get("data").cloned().unwrap_or(Value::Null));
    }
}
fn query(path: &Path, property: &str) -> Result<Value> {
    request(path, json!(["get_property", property]))
}
fn empty_status() -> PlayerStatus {
    PlayerStatus {
        file_id: None,
        error: None,
        running: false,
        paused: false,
        eof_reached: false,
        position: 0.0,
        duration: 0.0,
        speed: 1.0,
        volume: 100.0,
        tracks: Vec::new(),
    }
}
fn read_status(path: &Path) -> Result<PlayerStatus> {
    let properties = [
        "track-list",
        "pause",
        "eof-reached",
        "time-pos",
        "duration",
        "speed",
        "volume",
    ];
    let mut stream = connect(path)?;
    for (index, property) in properties.iter().enumerate() {
        writeln!(
            stream,
            "{}",
            json!({"command":["get_property", property], "request_id":index + 1})
        )?;
    }
    let mut reader = BufReader::new(stream);
    let mut values = std::collections::HashMap::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    while values.len() < properties.len() {
        if Instant::now() >= deadline {
            return Err(NimbusError::Validation("播放器状态等待超时".into()));
        }
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(NimbusError::Validation("播放器状态通道中断".into()));
        }
        let value: Value = serde_json::from_str(&line)?;
        if let Some(id) = value
            .get("request_id")
            .and_then(Value::as_u64)
            .filter(|id| *id >= 1 && *id <= properties.len() as u64)
        {
            values.insert(
                properties[id as usize - 1],
                value.get("data").cloned().unwrap_or(Value::Null),
            );
        }
    }
    let get = |name: &str| values.get(name).cloned().unwrap_or(Value::Null);
    let tracks = get("track-list")
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|track| {
            let kind = track.get("type")?.as_str()?.to_owned();
            if !matches!(kind.as_str(), "audio" | "sub") {
                return None;
            }
            Some(PlayerTrack {
                id: track.get("id")?.as_i64()?,
                kind,
                title: track
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("未命名轨道")
                    .to_owned(),
                language: track
                    .get("lang")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                selected: track
                    .get("selected")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect();
    Ok(PlayerStatus {
        file_id: None,
        error: None,
        running: true,
        paused: get("pause").as_bool().unwrap_or(false),
        eof_reached: get("eof-reached").as_bool().unwrap_or(false),
        position: get("time-pos").as_f64().unwrap_or_default(),
        duration: get("duration").as_f64().unwrap_or_default(),
        speed: get("speed").as_f64().unwrap_or(1.0),
        volume: get("volume").as_f64().unwrap_or(100.0),
        tracks,
    })
}

#[cfg(test)]
#[path = "tests/player.rs"]
mod tests;
