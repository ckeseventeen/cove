//! macOS: libmpv renders through OpenGL into an NSView of the library window (mpv_view.m), the
//! video controls are a child window above it, and mpv is driven over a Unix socket.
use std::{
    ffi::{c_char, c_int, c_void, CString},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    time::Duration,
};

use tauri::WebviewWindow;

use crate::error::{NimbusError, Result};

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
    fn nimbus_window_is_floating() -> c_int;
    fn nimbus_window_set_floating(window: *mut c_void, child: *mut c_void, floating: bool, aspect: f64) -> c_int;
}

/// The control channel to mpv.
pub type IpcStream = UnixStream;

/// Per-user temporary directory ($TMPDIR on macOS) so the IPC socket and log are private.
pub fn runtime_dir() -> PathBuf {
    let dir = std::env::temp_dir();
    // Unix socket paths are limited to 104 bytes on macOS.
    if dir.as_os_str().len() < 72 {
        dir
    } else {
        PathBuf::from("/tmp")
    }
}

pub fn ipc_path() -> PathBuf {
    runtime_dir().join(format!("cove-mpv-{}.sock", std::process::id()))
}

pub fn ipc_connect(path: &Path) -> Result<IpcStream> {
    let stream =
        UnixStream::connect(path).map_err(|_| NimbusError::Validation("播放器尚未启动".into()))?;
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    Ok(stream)
}

/// The NSWindow of a Tauri window.
pub fn window_handle(window: &WebviewWindow) -> Result<usize> {
    Ok(window
        .ns_window()
        .map_err(|error| NimbusError::Internal(format!("无法取得 Nimbus 原生窗口：{error}")))? as usize)
}

/// Create the video view in `window`; on the main thread.
pub fn view_create(window: usize) -> std::result::Result<usize, String> {
    let view = unsafe { nimbus_mpv_view_create(window as *mut c_void, 0.0) };
    if view.is_null() {
        Err("无法创建 OpenGL 视频视图".to_owned())
    } else {
        Ok(view as usize)
    }
}

pub fn view_clear(view: usize) {
    unsafe { nimbus_mpv_view_clear(view as *mut c_void) };
}

/// On the main thread.
pub fn view_set_hidden(view: usize, hidden: bool) {
    unsafe { nimbus_mpv_view_set_hidden(view as *mut c_void, hidden) };
}

/// On the main thread.
pub fn view_set_controls_height(view: usize, height: f64) {
    unsafe { nimbus_mpv_view_set_controls_height(view as *mut c_void, height) };
}

/// The view follows its window by itself (autoresizing).
pub fn view_layout(_view: usize) {}

/// Start libmpv, drawing into `view` and listening on `ipc`.
pub fn create_player(view: usize, ipc: &Path, log_path: &Path) -> Result<usize> {
    let handle = unsafe { mpv_create() };
    if handle.is_null() {
        return Err(NimbusError::Internal("libmpv 初始化失败".into()));
    }
    let socket_value = ipc.to_string_lossy().into_owned();
    let log_value = log_path.to_string_lossy().into_owned();
    let mut options = super::MPV_OPTIONS.to_vec();
    options.push(("input-ipc-server", socket_value.as_str()));
    options.push(("log-file", log_value.as_str()));
    for (name, value) in options {
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
    // Cove owns the system media keys through MPRemoteCommandCenter; older or
    // differently built libmpv versions may not know this option, so it is optional.
    for (name, value) in [("input-media-keys", "no")] {
        let name = CString::new(name).expect("static option name");
        let value = CString::new(value).expect("static option value");
        unsafe { mpv_set_option_string(handle, name.as_ptr(), value.as_ptr()) };
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
    Ok(handle as usize)
}

/// libmpv is linked into Cove; it cannot be missing at run time.
pub fn mpv_available() -> bool {
    true
}

/// The menu bar is the system's, outside the window.
pub fn sync_menu(_window: &WebviewWindow, _video: bool) {}

/// Whether the video window is the floating mini-player.
pub fn is_floating() -> bool {
    unsafe { nimbus_window_is_floating() == 1 }
}

/// Float the video window as a mini-player (`aspect` = the video's width / height), or put it back.
pub fn set_floating(parent: &WebviewWindow, child: Option<&WebviewWindow>, floating: bool, aspect: f64) -> Result<()> {
    let parent_window = parent
        .ns_window()
        .map_err(|error| NimbusError::Internal(format!("无法取得播放器主窗口：{error}")))? as usize;
    let child_window = child.and_then(|child| child.ns_window().ok()).map_or(0, |window| window as usize);
    parent
        .run_on_main_thread(move || unsafe {
            nimbus_window_set_floating(parent_window as *mut c_void, child_window as *mut c_void, floating, aspect);
        })
        .map_err(|error| NimbusError::Internal(format!("无法切换小窗播放：{error}")))
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
