//! Interface size (显示 › 放大 / 缩小 / 实际大小, 设置 › 界面大小): one page zoom shared by the
//! library window and the video controls, remembered across launches. The library window's
//! minimum size grows with it, so the layout never gets narrower than it was designed for.
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewWindow};

use crate::error::Result;

pub const LEVELS: [f64; 5] = [1.0, 1.1, 1.2, 1.3, 1.4];
/// The library window's minimum size at 100%, as in tauri.conf.json.
const MIN_SIZE: (f64, f64) = (900.0, 600.0);
const WINDOWS: [&str; 2] = ["main", "player-controls"];

pub struct UiZoom {
    path: PathBuf,
    level: Mutex<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiZoomState {
    level: f64,
    levels: Vec<f64>,
}

impl UiZoom {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("interface.json");
        let level = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| value.get("zoom").and_then(serde_json::Value::as_f64))
            .map(nearest)
            .unwrap_or(1.0);
        Self {
            path,
            level: Mutex::new(level),
        }
    }

    fn state(&self) -> UiZoomState {
        UiZoomState {
            level: *self.level.lock(),
            levels: LEVELS.to_vec(),
        }
    }

    fn save(&self, level: f64) -> Result<()> {
        let staging = self.path.with_extension("json.tmp");
        std::fs::write(&staging, serde_json::to_vec(&serde_json::json!({ "zoom": level }))?)?;
        std::fs::rename(&staging, &self.path)?;
        Ok(())
    }
}

/// The offered level closest to `level`, so a hand-edited or outdated value still lands on one.
fn nearest(level: f64) -> f64 {
    LEVELS
        .iter()
        .copied()
        .min_by(|a, b| (a - level).abs().total_cmp(&(b - level).abs()))
        .unwrap_or(1.0)
}

/// One level larger (+1) or smaller (−1), staying put at either end; 0 is actual size.
fn stepped(level: f64, direction: i32) -> f64 {
    if direction == 0 {
        return 1.0;
    }
    let index = LEVELS.iter().position(|candidate| *candidate == nearest(level)).unwrap_or(0) as i32;
    LEVELS[(index + direction).clamp(0, LEVELS.len() as i32 - 1) as usize]
}

/// Zoom both web windows to the remembered level; called at launch and after every change.
pub fn apply(app: &AppHandle) {
    let level = *app.state::<UiZoom>().level.lock();
    for label in WINDOWS {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_zoom(level);
        }
    }
    if let Some(main) = app.get_webview_window("main") {
        fit_min_size(&main, level);
    }
}

fn fit_min_size(window: &WebviewWindow, level: f64) {
    let monitor = window.current_monitor().ok().flatten();
    let (mut width, mut height) = (MIN_SIZE.0 * level, MIN_SIZE.1 * level);
    // Never ask for more than the screen can show.
    if let Some(monitor) = &monitor {
        let area = monitor.work_area().size.to_logical::<f64>(monitor.scale_factor());
        width = width.min(area.width);
        height = height.min(area.height);
    }
    // A smaller window grows to the new minimum, keeping its top left corner.
    let _ = window.set_min_size(Some(LogicalSize::new(width, height)));
    if window.is_fullscreen().unwrap_or(false) {
        return;
    }
    // Growing may have pushed its right or bottom edge off the screen: move it back on.
    let (Some(monitor), Ok(position), Ok(size)) = (monitor, window.outer_position(), window.outer_size())
    else {
        return;
    };
    let area = monitor.work_area();
    let right = area.position.x + area.size.width as i32;
    let bottom = area.position.y + area.size.height as i32;
    let x = position.x.min(right - size.width as i32).max(area.position.x);
    let y = position.y.min(bottom - size.height as i32).max(area.position.y);
    if (x, y) != (position.x, position.y) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

fn set(app: &AppHandle, level: f64) -> Result<UiZoomState> {
    let zoom = app.state::<UiZoom>();
    let level = nearest(level);
    *zoom.level.lock() = level;
    apply(app);
    let _ = app.emit("ui-zoom", level);
    zoom.save(level)?;
    Ok(zoom.state())
}

/// 显示 › 放大 (+1), 缩小 (−1) and 实际大小 (0).
pub fn step(app: &AppHandle, direction: i32) {
    let current = *app.state::<UiZoom>().level.lock();
    let next = stepped(current, direction);
    if next != current {
        if let Err(error) = set(app, next) {
            eprintln!("Cove could not remember the interface size: {error}");
        }
    }
}

#[tauri::command]
pub fn ui_zoom_get(zoom: State<'_, UiZoom>) -> UiZoomState {
    zoom.state()
}

#[tauri::command]
pub fn ui_zoom_set(level: f64, app: AppHandle) -> Result<UiZoomState> {
    set(&app, level)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_stop_at_either_end_and_zero_is_actual_size() {
        assert_eq!(stepped(1.0, 1), 1.1);
        assert_eq!(stepped(1.2, -1), 1.1);
        assert_eq!(stepped(1.0, -1), 1.0);
        assert_eq!(stepped(1.4, 1), 1.4);
        assert_eq!(stepped(1.3, 0), 1.0);
    }

    #[test]
    fn saved_values_land_on_an_offered_level() {
        assert_eq!(nearest(1.19), 1.2);
        assert_eq!(nearest(0.5), 1.0);
        assert_eq!(nearest(3.0), 1.4);
    }

    #[test]
    fn the_level_survives_a_relaunch() {
        let directory = std::env::temp_dir().join(format!("cove-ui-zoom-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        assert_eq!(*UiZoom::load(&directory).level.lock(), 1.0);
        UiZoom::load(&directory).save(1.3).unwrap();
        assert_eq!(*UiZoom::load(&directory).level.lock(), 1.3);
        std::fs::write(directory.join("interface.json"), b"not json").unwrap();
        assert_eq!(*UiZoom::load(&directory).level.lock(), 1.0);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
