mod ai_subtitles;
mod commands;
mod config;
mod credentials;
mod direct;
mod error;
pub mod http_client;
mod local_storage;
pub mod media_types;
mod metadata;
mod model;
mod player;
mod proxy;
mod store;
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
                        continue;
                    }
                    let status = state.player.status().await;
                    if let Some(id) = &status.file_id {
                        state.proxy.renew(id).await;
                    }
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
            if let Ok(test_media) = std::env::var("NIMBUS_TEST_MEDIA") {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    let Some(window) = app_handle.get_webview_window("main") else {
                        eprintln!("Nimbus player self-test: main window is unavailable");
                        return;
                    };
                    let player = app_handle.state::<AppState>().player.clone();
                    if let Err(error) = player
                        .open(
                            window,
                            "__nimbus_self_test__".into(),
                            test_media,
                            "Nimbus libmpv self-test".into(),
                            0.0,
                            1.0,
                            true,
                        )
                        .await
                    {
                        eprintln!("Nimbus player self-test failed: {error}");
                    } else {
                        if let (Some(main), Some(controls)) = (
                            app_handle.get_webview_window("main"),
                            app_handle.get_webview_window("player-controls"),
                        ) {
                            let _ = player::attach_controls_window(&main, &controls);
                            let _ = controls.show();
                        }
                        let snapshot = player.status().await;
                        eprintln!(
                            "Nimbus player self-test: running={}, duration={}",
                            snapshot.running, snapshot.duration
                        );
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
            commands::playback::player_add_subtitle,
            ai_subtitles::ai_subtitles_cached,
            ai_subtitles::ai_subtitles_generate,
            commands::metadata::music_metadata,
            commands::metadata::movie_metadata,
            commands::transfers::entry_copy,
            commands::transfers::folder_create,
            commands::storage::storage_play_file,
            commands::storage::open_native_path,
            commands::storage::reveal_native_path,
            commands::storage::read_text_preview
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
                api.prevent_close();
                let player = window.state::<AppState>().player.clone();
                let app_handle = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<AppState>();
                    let is_playing =
                        player.current_file_id().is_some() || player.cached_status().running;
                    if is_playing {
                        player.cancel_pending_open();
                        let snapshot = player.cached_status();
                        if let Some(id) = snapshot.file_id.filter(|_| snapshot.duration > 0.0) {
                            let _ = state.store.save_playback_progress(
                                &id,
                                snapshot.position,
                                snapshot.duration,
                                snapshot.speed,
                            );
                        }
                        let _ = player.control("stop".into(), None).await;
                        state.proxy.revoke_all().await;
                        let _ = app_handle.emit("nimbus-player-state", player.cached_status());
                        if let Some(webview) = app_handle.get_webview_window("main") {
                            let _ = player.set_view_visible(&webview, false).await;
                            let _ = webview.set_fullscreen(false);
                            let _ = webview.emit("nimbus-player-stopped", ());
                            let _ = webview.set_focus();
                        }
                        if let Some(controls) = app_handle.get_webview_window("player-controls") {
                            let _ = controls.hide();
                            let _ = player::detach_controls_window(&controls);
                        }
                    } else {
                        if let Some(webview) = app_handle.get_webview_window("main") {
                            let _ = webview.hide();
                        }
                    }
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Cove")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        });
}
