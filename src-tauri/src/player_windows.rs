//! Windows: libmpv draws into a child window of the library window (mpv's own `wid` embedding),
//! the video controls are a transparent window owned by it, and mpv is driven over a named pipe.
//! libmpv-2.dll is loaded at run time from beside Cove.exe.
use std::{
    ffi::{c_char, c_int, c_void, CString},
    fs::File,
    io::{self, Read, Write},
    os::windows::io::AsRawHandle,
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{HWND, RECT},
    Graphics::Gdi::{GetMonitorInfoW, GetStockObject, InvalidateRect, MonitorFromWindow, BLACK_BRUSH, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    System::{LibraryLoader::GetModuleHandleW, Pipes::PeekNamedPipe},
    UI::{
        HiDpi::GetDpiForWindow,
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, GetClientRect, GetForegroundWindow, GetParent, RegisterClassW, SendMessageW, SetWindowLongPtrW, SetWindowPos,
            ShowWindow, GWLP_HWNDPARENT, SWP_NOACTIVATE, SW_HIDE, SW_SHOWNA, WM_NCACTIVATE, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN,
            WS_CLIPSIBLINGS,
        },
    },
};

use crate::error::{NimbusError, Result};

type MpvHandle = c_void;

/// The few libmpv functions Cove calls; everything else goes over the pipe.
struct Mpv {
    create: unsafe extern "C" fn() -> *mut MpvHandle,
    initialize: unsafe extern "C" fn(*mut MpvHandle) -> c_int,
    set_option_string: unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int,
    terminate_destroy: unsafe extern "C" fn(*mut MpvHandle),
    /// Kept loaded for as long as Cove runs; the functions above point into it.
    _library: libloading::Library,
}

static MPV: OnceLock<std::result::Result<Mpv, String>> = OnceLock::new();

fn load_mpv() -> std::result::Result<Mpv, String> {
    let beside = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.join("libmpv-2.dll")));
    let library = match beside.filter(|path| path.is_file()) {
        // Present but not loadable: what it needs is missing, most likely vulkan-1.dll, which comes
        // with the graphics driver.
        Some(path) => unsafe { libloading::Library::new(path) }
            .map_err(|error| format!("无法加载播放组件。请更新显卡驱动（需要其中的 Vulkan 组件 vulkan-1.dll）后重试（{error}）"))?,
        None => unsafe { libloading::Library::new("libmpv-2.dll") }
            .map_err(|error| format!("找不到播放组件 libmpv-2.dll，请重新安装 Cove（{error}）"))?,
    };
    let symbol = |name: &str| format!("libmpv-2.dll 版本不兼容，缺少 {name}");
    unsafe {
        let create = *library.get::<unsafe extern "C" fn() -> *mut MpvHandle>(b"mpv_create\0").map_err(|_| symbol("mpv_create"))?;
        let initialize = *library
            .get::<unsafe extern "C" fn(*mut MpvHandle) -> c_int>(b"mpv_initialize\0")
            .map_err(|_| symbol("mpv_initialize"))?;
        let set_option_string = *library
            .get::<unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int>(b"mpv_set_option_string\0")
            .map_err(|_| symbol("mpv_set_option_string"))?;
        let terminate_destroy = *library
            .get::<unsafe extern "C" fn(*mut MpvHandle)>(b"mpv_terminate_destroy\0")
            .map_err(|_| symbol("mpv_terminate_destroy"))?;
        Ok(Mpv { create, initialize, set_option_string, terminate_destroy, _library: library })
    }
}

fn mpv() -> Result<&'static Mpv> {
    MPV.get_or_init(load_mpv).as_ref().map_err(|error| NimbusError::Internal(error.clone()))
}

/// Whether libmpv-2.dll, and what it needs, can be loaded.
pub fn mpv_available() -> bool {
    mpv().is_ok()
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The control channel to mpv: a named pipe client whose reads give up after a second, as the
/// macOS socket's do, so a slow reply is waited for in steps instead of blocking forever.
pub struct IpcStream {
    pipe: File,
}

impl Read for IpcStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let mut available = 0u32;
            let peeked = unsafe {
                PeekNamedPipe(self.pipe.as_raw_handle(), null_mut(), 0, null_mut(), &mut available, null_mut())
            };
            if peeked == 0 {
                return Err(io::Error::last_os_error());
            }
            if available > 0 {
                let length = buffer.len().min(available as usize);
                return self.pipe.read(&mut buffer[..length]);
            }
            if Instant::now() >= deadline {
                return Err(io::ErrorKind::TimedOut.into());
            }
            thread::sleep(Duration::from_millis(4));
        }
    }
}

impl Write for IpcStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.pipe.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.pipe.flush()
    }
}

pub fn runtime_dir() -> PathBuf {
    std::env::temp_dir()
}

pub fn ipc_path() -> PathBuf {
    PathBuf::from(format!(r"\\.\pipe\cove-mpv-{}", std::process::id()))
}

pub fn ipc_connect(path: &Path) -> Result<IpcStream> {
    const PIPE_BUSY: i32 = 231;
    for _ in 0..40 {
        match std::fs::OpenOptions::new().read(true).write(true).open(path) {
            Ok(pipe) => return Ok(IpcStream { pipe }),
            // mpv opens the next instance of the pipe right after a client connects.
            Err(error) if error.raw_os_error() == Some(PIPE_BUSY) => thread::sleep(Duration::from_millis(25)),
            Err(_) => break,
        }
    }
    Err(NimbusError::Validation("播放器尚未启动".into()))
}

/// The HWND of a Tauri window.
pub fn window_handle(window: &WebviewWindow) -> Result<usize> {
    Ok(window
        .hwnd()
        .map_err(|error| NimbusError::Internal(format!("无法取得 Cove 窗口：{error}")))?
        .0 as usize)
}

/// The height (logical pixels) the controls keep below the picture.
static CONTROLS_HEIGHT: AtomicU64 = AtomicU64::new(0);

fn register_class() -> &'static [u16] {
    static CLASS: OnceLock<Vec<u16>> = OnceLock::new();
    CLASS.get_or_init(|| {
        let name = wide("CoveVideo");
        let class = WNDCLASSW {
            lpfnWndProc: Some(DefWindowProcW),
            hInstance: unsafe { GetModuleHandleW(null()) },
            hbrBackground: unsafe { GetStockObject(BLACK_BRUSH) },
            lpszClassName: name.as_ptr(),
            ..unsafe { std::mem::zeroed() }
        };
        unsafe { RegisterClassW(&class) };
        name
    })
}

/// Create the (hidden) video window inside `window`; on the main thread.
pub fn view_create(window: usize) -> std::result::Result<usize, String> {
    let class = register_class();
    let parent = window as HWND;
    let mut client: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(parent, &mut client) };
    let view = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            null(),
            WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            0,
            0,
            client.right.max(1),
            client.bottom.max(1),
            parent,
            null_mut(),
            GetModuleHandleW(null()),
            null(),
        )
    };
    if view.is_null() {
        Err("无法创建视频窗口".to_owned())
    } else {
        Ok(view as usize)
    }
}

pub fn view_clear(view: usize) {
    unsafe { InvalidateRect(view as HWND, null(), 1) };
}

/// Fill the library window above the controls' space, in front of the web view; on the main thread.
pub fn view_layout(view: usize) {
    let view = view as HWND;
    unsafe {
        let parent = GetParent(view);
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(parent, &mut client);
        let scale = GetDpiForWindow(view).max(96) as f64 / 96.0;
        let controls = (f64::from_bits(CONTROLS_HEIGHT.load(Ordering::Relaxed)) * scale).round() as i32;
        // A null insert-after window is HWND_TOP.
        SetWindowPos(view, null_mut(), 0, 0, client.right.max(1), (client.bottom - controls).max(1), SWP_NOACTIVATE);
    }
}

/// On the main thread.
pub fn view_set_hidden(view: usize, hidden: bool) {
    if !hidden {
        view_layout(view);
    }
    unsafe { ShowWindow(view as HWND, if hidden { SW_HIDE } else { SW_SHOWNA }) };
}

/// On the main thread.
pub fn view_set_controls_height(view: usize, height: f64) {
    CONTROLS_HEIGHT.store(height.to_bits(), Ordering::Relaxed);
    view_layout(view);
}

/// Start libmpv, drawing into `view` and listening on `ipc`.
pub fn create_player(view: usize, ipc: &Path, log_path: &Path) -> Result<usize> {
    let mpv = mpv()?;
    let handle = unsafe { (mpv.create)() };
    if handle.is_null() {
        return Err(NimbusError::Internal("libmpv 初始化失败".into()));
    }
    let window = (view as i64).to_string();
    let pipe = ipc.to_string_lossy().into_owned();
    let log = log_path.to_string_lossy().into_owned();
    let mut options = super::MPV_OPTIONS.to_vec();
    options.extend([
        ("wid", window.as_str()),
        // The controls window above takes the mouse and the keyboard.
        ("input-default-bindings", "no"),
        ("input-vo-keyboard", "no"),
        ("input-cursor", "no"),
        ("cursor-autohide", "no"),
        ("input-ipc-server", pipe.as_str()),
        ("log-file", log.as_str()),
    ]);
    for (name, value) in options {
        let name = CString::new(name).expect("static option name");
        let value = CString::new(value).map_err(|_| NimbusError::Internal("libmpv 选项包含无效字符".into()))?;
        let result = unsafe { (mpv.set_option_string)(handle, name.as_ptr(), value.as_ptr()) };
        if result < 0 {
            unsafe { (mpv.terminate_destroy)(handle) };
            return Err(NimbusError::Internal(format!("libmpv 设置选项失败（错误 {result}）")));
        }
    }
    // Cove owns the media keys through the system media controls (now_playing.rs).
    let (name, value) = (CString::new("input-media-keys").expect("static"), CString::new("no").expect("static"));
    unsafe { (mpv.set_option_string)(handle, name.as_ptr(), value.as_ptr()) };
    let result = unsafe { (mpv.initialize)(handle) };
    if result < 0 {
        unsafe { (mpv.terminate_destroy)(handle) };
        return Err(NimbusError::Internal(format!("libmpv 启动失败（错误 {result}）")));
    }
    Ok(handle as usize)
}

/// Where the window was before it became the mini-player.
struct Docked {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
}

static FLOATING: Mutex<Option<Docked>> = Mutex::new(None);

/// Whether the video window is the floating mini-player.
pub fn is_floating() -> bool {
    FLOATING.lock().is_some()
}

/// The window's menu bar stays out of a video in full screen or the mini-player, where only the
/// picture shows; the library keeps it, even in full screen, so F11 is always on screen.
pub fn sync_menu(window: &WebviewWindow, video: bool) {
    let bare = video && (is_floating() || window.is_fullscreen().unwrap_or(false));
    if window.is_menu_visible().unwrap_or(bare) == bare {
        let _ = if bare { window.hide_menu() } else { window.show_menu() };
    }
}

/// The part of the window's screen not taken by the taskbar, in physical pixels.
fn work_area(window: &WebviewWindow) -> Result<RECT> {
    let hwnd = window_handle(window)? as HWND;
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return Err(NimbusError::Internal("无法取得屏幕大小".into()));
        }
        Ok(info.rcWork)
    }
}

fn window_error(error: tauri::Error) -> NimbusError {
    NimbusError::Internal(format!("无法切换小窗播放：{error}"))
}

/// Float the video window as a mini-player in the corner of its screen, above other windows and
/// keeping the video's shape (`aspect` = width / height), or put it back where it was.
pub fn set_floating(parent: &WebviewWindow, child: Option<&WebviewWindow>, floating: bool, aspect: f64) -> Result<()> {
    if floating == is_floating() {
        return Ok(());
    }
    if floating {
        if parent.is_fullscreen().unwrap_or(false) {
            return Ok(());
        }
        let docked = Docked {
            position: parent.outer_position().map_err(window_error)?,
            size: parent.inner_size().map_err(window_error)?,
            maximized: parent.is_maximized().unwrap_or(false),
        };
        let maximized = docked.maximized;
        // Floating from here on, so the resizes below already see the mini-player.
        *FLOATING.lock() = Some(docked);
        sync_menu(parent, true);
        if maximized {
            parent.unmaximize().map_err(window_error)?;
        }
        let size = parent.inner_size().map_err(window_error)?;
        let frame = parent.outer_size().map_err(window_error)?;
        let (border_x, border_y) = (frame.width.saturating_sub(size.width), frame.height.saturating_sub(size.height));
        let area = work_area(parent)?;
        let scale = parent.scale_factor().unwrap_or(1.0);
        let ratio = if aspect > 0.2 && aspect < 5.0 { aspect } else { 16.0 / 9.0 };
        let width = (480.0 * scale).min((area.right - area.left) as f64 / 3.0).round();
        let height = (width / ratio).round();
        let margin = (16.0 * scale).round() as i32;
        parent.set_min_size(Some(LogicalSize::new(240.0, 135.0))).map_err(window_error)?;
        parent.set_size(PhysicalSize::new(width as u32, height as u32)).map_err(window_error)?;
        parent
            .set_position(PhysicalPosition::new(
                area.right - width as i32 - border_x as i32 - margin,
                area.bottom - height as i32 - border_y as i32 - margin,
            ))
            .map_err(window_error)?;
        parent.set_always_on_top(true).map_err(window_error)?;
        if let Some(child) = child {
            let _ = child.set_always_on_top(true);
        }
    } else {
        let Some(docked) = FLOATING.lock().take() else {
            return Ok(());
        };
        sync_menu(parent, true);
        parent.set_always_on_top(false).map_err(window_error)?;
        if let Some(child) = child {
            let _ = child.set_always_on_top(false);
        }
        crate::ui_zoom::apply_min_size(parent);
        parent.set_size(docked.size).map_err(window_error)?;
        parent.set_position(docked.position).map_err(window_error)?;
        if docked.maximized {
            parent.maximize().map_err(window_error)?;
        }
    }
    Ok(())
}

/// Lay the controls window over the library window's client area, owned by it so it stays in
/// front of it and minimizes with it.
pub fn attach_controls_window(parent: &WebviewWindow, child: &WebviewWindow) -> Result<()> {
    let error = |error: tauri::Error| NimbusError::Internal(format!("无法显示播放器控制层：{error}"));
    let (owner, owned) = (window_handle(parent)?, window_handle(child)?);
    parent
        .run_on_main_thread(move || unsafe {
            SetWindowLongPtrW(owned as HWND, GWLP_HWNDPARENT, owner as isize);
        })
        .map_err(error)?;
    child.set_position(parent.inner_position().map_err(error)?).map_err(error)?;
    child.set_size(parent.inner_size().map_err(error)?).map_err(error)?;
    Ok(())
}

/// The controls are a window of their own, so the library window's title bar turns inactive
/// whenever they take the keyboard. Draw it as the controls are: active while they are.
pub fn show_owner_active(parent: &WebviewWindow, active: bool) {
    if let Ok(owner) = window_handle(parent) {
        let _ = parent.run_on_main_thread(move || unsafe {
            // Leaving the controls for the library window itself: that is active for real.
            if !active && GetForegroundWindow() == owner as HWND {
                return;
            }
            SendMessageW(owner as HWND, WM_NCACTIVATE, active as usize, 0);
        });
    }
}

/// The controls window stays owned by the library window while hidden; nothing to undo.
pub fn detach_controls_window(_child: &WebviewWindow) -> Result<()> {
    Ok(())
}
