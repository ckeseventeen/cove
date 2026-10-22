mod ai_subtitles;
mod auto_scan;
mod commands;
mod config;
mod credentials;
mod direct;
mod documents;
mod error;
pub mod http_client;
mod local_storage;
pub mod media_types;
mod menu;
mod metadata;
mod model;
mod now_playing;
mod player;
mod proxy;
mod sidecar_subtitles;
mod store;
mod ui_zoom;
mod webdav;

use std::{process::Command, sync::Arc, time::Duration};

use error::{NimbusError, Result};
use keyring::Entry;
use model::{Account, AccountInput, AppStatus, CloudEntry, MediaFile, MediaSource, ScanResult};
use store::Store;
use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;
use zeroize::Zeroizing;

static METADATA_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(6);

struct AppState {
    store: Arc<Store>,
    proxy: Arc<proxy::StreamProxy>,
    credentials: proxy::CredentialCache,
    player: player::PlayerController,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = std::env::var_os("NIMBUS_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let store = Store::open(&data_dir.join("nimbus_media.db"))
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            store
                .ensure_local_account()
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            let store = Arc::new(store);
            let credentials = Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));
            let proxy = proxy::StreamProxy::start(Arc::clone(&store), Arc::clone(&credentials))
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            app.manage(AppState {
                store,
                proxy: Arc::new(proxy),
                credentials,
                player: player::PlayerController::new(),
            });
            app.manage(ui_zoom::UiZoom::load(&data_dir));
            ui_zoom::apply(app.handle());
            app.set_menu(menu::build(app.handle())?)?;
            app.on_menu_event(|app, event| menu::handle(app, event.id().as_ref()));
            now_playing::install(app.handle().clone());
            documents::install(app.handle().clone());
            auto_scan::start(app.handle().clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(500));
                let mut last_save = std::time::Instant::now();
                let poll_semaphore = tokio::sync::Semaphore::new(1);
                loop {
                    interval.tick().await;
                    let Ok(_permit) = poll_semaphore.try_acquire() else {
                        continue;
                    };
                    let state = handle.state::<AppState>();
                    if state.player.current_file_id().is_none() {
                        now_playing::sync(&state.player.cached_status(), |_| Default::default());
                        continue;
                    }
                    let status = state.player.status().await;
                    if let Some(id) = &status.file_id {
                        state.proxy.renew(id).await;
                    }
                    now_playing::sync(&status, |id| describe_file(&state.store, id));
                    let _ = handle.emit("nimbus-player-state", &status);
                    if last_save.elapsed() >= Duration::from_secs(30) {
                        if let Some(id) = status.file_id.as_ref().filter(|_| status.duration > 0.0)
                        {
                            let _ = state.store.save_playback_progress(
                                id,
                                status.position,
                                status.duration,
                                status.speed,
                            );
                        }
                        last_save = std::time::Instant::now();
                    }
                }
            });
            // Developer self-test: play a local file through the normal playback path.
            if let Ok(test_media) = std::env::var("NIMBUS_TEST_MEDIA") {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    if let Err(error) = run_self_test(&app_handle, &test_media).await {
                        eprintln!("Cove player self-test failed: {error}");
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            credentials::ai_key_load,
            credentials::ai_key_save,
            commands::library::app_status,
            commands::library::playback_recent,
            commands::library::metadata_cached_movies,
            commands::library::metadata_cache_clear,
            commands::accounts::account_list,
            commands::accounts::account_add,
            commands::accounts::account_remove,
            commands::accounts::baidu_oauth_connect,
            commands::accounts::baidu_oauth_cancel,
            commands::accounts::account_update_credentials,
            commands::accounts::account_browse,
            commands::accounts::account_scan,
            commands::library::media_file_list,
            commands::library::media_source_list,
            commands::library::media_source_add,
            commands::library::media_source_remove,
            commands::library::media_source_scan,
            commands::playback::player_stream_url,
            commands::playback::player_open_native,
            commands::playback::player_control,
            commands::playback::player_status,
            commands::playback::player_current_file,
            commands::playback::player_playlist,
            ai_subtitles::ai_subtitles_cached,
            ai_subtitles::ai_subtitles_generate,
            commands::metadata::music_metadata,
            commands::metadata::movie_metadata,
            commands::transfers::entry_copy,
            commands::transfers::folder_create,
            commands::storage::storage_play_file,
            commands::storage::open_native_path,
            commands::storage::reveal_native_path,
            commands::storage::read_text_preview,
            now_playing::now_playing_info,
            documents::document_open,
            documents::document_open_file,
            documents::document_progress_list,
            commands::library::playlist_list,
            commands::library::playlist_create,
            commands::library::playlist_rename,
            commands::library::playlist_delete,
            commands::library::playlist_set_items,
            ui_zoom::ui_zoom_get,
            ui_zoom::ui_zoom_set
        ])
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                )
            {
                if let Some(controls) = window.app_handle().get_webview_window("player-controls") {
                    if controls.is_visible().unwrap_or(false) {
                        if let Some(main) = window.app_handle().get_webview_window("main") {
                            let _ = player::attach_controls_window(&main, &controls);
                        }
                    }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                let app_handle = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<AppState>();
                    let current = state
                        .player
                        .current_file_id()
                        .and_then(|id| state.store.get_media_file(&id).ok());
                    let playing_video = current
                        .as_ref()
                        .is_some_and(|file| file.media_kind.as_deref() != Some("music"));
                    // A video still loading has no current file yet, but its controls are up.
                    if playing_video || video_ui_visible(&app_handle) {
                        // Like closing a QuickTime document: leave the video, keep the library.
                        stop_playback(&app_handle).await;
                        return;
                    }
                    if current.is_none() {
                        state.player.cancel_pending_open();
                    }
                    if let Some(webview) = app_handle.get_webview_window("main") {
                        // Like Music: the window goes away, the song keeps playing.
                        let _ = webview.hide();
                    }
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Cove")
        .run(|app_handle, event| match event {
            tauri::RunEvent::Reopen { .. } => show_main_window(app_handle),
            tauri::RunEvent::Exit => {
                let state = app_handle.state::<AppState>();
                save_current_progress(&state);
                state.player.cleanup();
            }
            _ => {}
        });
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

async fn run_self_test(app_handle: &tauri::AppHandle, path: &str) -> Result<()> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| NimbusError::Internal("main window is unavailable".into()))?;
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("self-test")
        .to_owned();
    let extension = name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default();
    let kind = if media_types::AUDIO_EXTENSIONS.contains(&extension.as_str()) {
        "music"
    } else {
        "movie"
    };
    let size = std::fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
    let state = app_handle.state::<AppState>();
    if media_types::is_document(&name) {
        let progress = documents::document_open(
            "local".into(),
            path.into(),
            None,
            name,
            Some(size),
            app_handle.clone(),
            state.clone(),
        )
        .await?;
        eprintln!("Cove reader self-test: page={} of {}", progress.page, progress.page_count);
        return Ok(());
    }
    let file_id = state
        .store
        .ensure_media_file("local", path, Some(path), &name, kind, size)?;
    commands::playback::player_open_native(file_id, Some(true), window, state.clone()).await?;
    let snapshot = state.player.status().await;
    eprintln!(
        "Cove player self-test: kind={kind}, running={}, duration={}",
        snapshot.running, snapshot.duration
    );
    Ok(())
}

fn describe_file(store: &Store, file_id: &str) -> (String, bool) {
    match store.get_media_file(file_id) {
        Ok(file) => {
            let title = file
                .display_name
                .rsplit_once('.')
                .map(|(stem, _)| stem.to_owned())
                .unwrap_or(file.display_name);
            (title, file.media_kind.as_deref() != Some("music"))
        }
        Err(_) => ("Cove".into(), false),
    }
}

fn save_current_progress(state: &AppState) {
    let snapshot = state.player.cached_status();
    if let Some(id) = snapshot.file_id.filter(|_| snapshot.duration > 0.0) {
        let _ = state.store.save_playback_progress(
            &id,
            snapshot.position,
            snapshot.duration,
            snapshot.speed,
        );
    }
}

/// The video controls are showing: a video is playing, or one is still loading.
pub(crate) fn video_ui_visible(app_handle: &tauri::AppHandle) -> bool {
    app_handle
        .get_webview_window("player-controls")
        .and_then(|controls| controls.is_visible().ok())
        .unwrap_or(false)
}

/// Stop playback, save progress and return the window to the library.
pub(crate) async fn stop_playback(app_handle: &tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    let player = state.player.clone();
    player.cancel_pending_open();
    save_current_progress(&state);
    let _ = player.control("stop".into(), None).await;
    state.proxy.revoke_all().await;
    show_library(app_handle, true).await;
}

/// Tell both windows nothing is playing, hide the video and give the window back to the
/// library. Full screen is left only when it belonged to a video, not to the library.
/// Without `focus`, the library only takes the keyboard back from the video controls,
/// so a failure in the background does not pull Cove to the front.
pub(crate) async fn show_library(app_handle: &tauri::AppHandle, focus: bool) {
    let state = app_handle.state::<AppState>();
    let player = state.player.clone();
    let video_ui = video_ui_visible(app_handle);
    let controls_focused = app_handle
        .get_webview_window("player-controls")
        .and_then(|controls| controls.is_focused().ok())
        .unwrap_or(false);
    let _ = app_handle.emit("nimbus-player-state", player.cached_status());
    let _ = app_handle.emit("nimbus-player-stopped", ());
    if let Some(webview) = app_handle.get_webview_window("main") {
        let _ = player.set_view_visible(&webview, false).await;
        if video_ui {
            let _ = webview.set_fullscreen(false);
        }
        if focus || controls_focused {
            let _ = webview.set_focus();
        }
    }
    if let Some(controls) = app_handle.get_webview_window("player-controls") {
        let _ = controls.hide();
        let _ = player::detach_controls_window(&controls);
    }
}
