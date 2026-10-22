use super::super::*;

#[tauri::command]
pub(crate) async fn player_stream_url(
    file_id: String,
    state: State<'_, AppState>,
) -> Result<String> {
    state.store.get_media_file(&file_id)?;
    Ok(state.proxy.create_url(file_id).await)
}

#[tauri::command]
pub(crate) async fn player_open_native(
    file_id: String,
    from_start: Option<bool>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<()> {
    let opened = open_native(file_id.clone(), from_start, &window, &state).await;
    if let Err(error) = &opened {
        // A cancelled open was replaced by a newer one or a stop, which own the windows now.
        if !player::is_cancelled(error) && state.player.current_file_id().is_none() {
            // Nothing plays any more: both windows go back to the library.
            crate::show_library(window.app_handle(), false).await;
            if window.label() != "main" {
                // The video controls that asked are hidden now, so the library window says why.
                let name = state
                    .store
                    .get_media_file(&file_id)
                    .map(|file| file.display_name)
                    .unwrap_or_default();
                let payload = serde_json::json!({
                    "fileId": file_id,
                    "name": name,
                    "message": error.to_string(),
                });
                let _ = window.app_handle().emit("nimbus-player-error", payload);
            }
        }
    }
    opened
}

async fn open_native(
    file_id: String,
    from_start: Option<bool>,
    window: &tauri::WebviewWindow,
    state: &AppState,
) -> Result<()> {
    let main = window
        .app_handle()
        .get_webview_window("main")
        .unwrap_or_else(|| window.clone());
    state.player.cancel_pending_open();
    state.player.keep_playlist_for(&file_id);
    let previous = state.player.cached_status();
    if let Some(id) = previous.file_id.filter(|_| previous.duration > 0.0) {
        state.store.save_playback_progress(
            &id,
            previous.position,
            previous.duration,
            previous.speed,
        )?;
    }
    let file = state.store.get_media_file(&file_id)?;
    // A lesson not started yet plays at the speed its course was last watched at.
    let (mut position, speed) = match state.store.playback_progress(&file_id)? {
        Some(saved) => saved,
        None => {
            let siblings: Vec<String> = state.player.playlist().into_iter().map(|file| file.id).filter(|id| *id != file_id).collect();
            (0.0, state.store.latest_speed(&siblings)?.unwrap_or(1.0))
        }
    };
    if from_start.unwrap_or(false) {
        position = 0.0;
    }
    let account = state.store.get_account(&file.account_id)?;
    let show_video = file.media_kind.as_deref() != Some("music");
    let url = if let Some(copy) = crate::offline::local_copy(&file) {
        // Downloaded for offline viewing: no streaming.
        copy.to_string_lossy().into_owned()
    } else if account.account.provider == "local" {
        file.remote_path.clone()
    } else if account.account.provider == "smb" {
        // mpv reads the mounted share directly, like a file on this Mac.
        crate::smb::local_file(state, &file.account_id, &file.remote_path).await?.to_string_lossy().into_owned()
    } else {
        state.proxy.create_url(file_id.clone()).await
    };
    // Show the controls while opening too, so a slow cloud stream has an exit path.
    if show_video {
        if let Some(controls) = window.app_handle().get_webview_window("player-controls") {
            player::attach_controls_window(&main, &controls)?;
            controls.show().map_err(|error| NimbusError::Internal(error.to_string()))?;
            controls.set_focus().map_err(|error| NimbusError::Internal(error.to_string()))?;
        }
    }
    state
        .player
        .open(
            main.clone(),
            file_id,
            url,
            file.display_name,
            position,
            speed,
            show_video,
        )
        .await?;
    let snapshot = state.player.status().await;
    let _ = window.app_handle().emit("nimbus-player-state", &snapshot);
    if !show_video {
        // Songs feed 最常播放 and 最近播放.
        let _ = state.store.record_play(&file.id);
    }
    if let Some(controls) = window.app_handle().get_webview_window("player-controls") {
        if show_video {
            player::attach_controls_window(&main, &controls)?;
            controls.show().map_err(|error| NimbusError::Internal(error.to_string()))?;
            controls.set_focus().map_err(|error| NimbusError::Internal(error.to_string()))?;
        } else {
            let _ = controls.hide();
            let _ = player::detach_controls_window(&controls);
            let _ = main.set_focus();
        }
    }
    // Subtitles generated earlier come back with their video.
    crate::ai_subtitles::restore_saved(window.app_handle(), state, &file.id).await;
    // Subtitle files beside the video arrive once found, without holding up playback.
    if show_video {
        tauri::async_runtime::spawn(crate::sidecar_subtitles::load(window.app_handle().clone(), file.id.clone()));
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn playback_mark(file_ids: Vec<String>, watched: bool, state: State<'_, AppState>) -> Result<()> {
    state.store.mark_watched(&file_ids, watched)
}

#[tauri::command]
pub(crate) async fn player_control(
    action: String,
    value: Option<f64>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<()> {
    if action == "float" || action == "unfloat" {
        let main = window.app_handle().get_webview_window("main").unwrap_or_else(|| window.clone());
        let controls = window.app_handle().get_webview_window("player-controls");
        let floating = action == "float" && !player::is_floating();
        if floating && main.is_fullscreen().unwrap_or(false) {
            // Leave full screen first; the window can float once it is back on the desktop.
            let _ = main.set_fullscreen(false);
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
        let aspect = state.player.video_aspect().await.unwrap_or(16.0 / 9.0);
        player::set_floating(&main, controls.as_ref(), floating, aspect)?;
        let _ = window.app_handle().emit("player-floating", floating);
        return Ok(());
    }
    if action == "fullscreen" || action == "exit_fullscreen" {
        let main = window
            .app_handle()
            .get_webview_window("main")
            .unwrap_or_else(|| window.clone());
        // In the mini-player, full screen (double-click, F) first brings the window back.
        if player::is_floating() {
            let controls = window.app_handle().get_webview_window("player-controls");
            player::set_floating(&main, controls.as_ref(), false, 0.0)?;
            let _ = window.app_handle().emit("player-floating", false);
            return Ok(());
        }
        let fullscreen = main
            .is_fullscreen()
            .map_err(|error| NimbusError::Internal(error.to_string()))?;
        main.set_fullscreen(action != "exit_fullscreen" && !fullscreen)
            .map_err(|error| NimbusError::Internal(error.to_string()))?;
        if let Some(controls) = window.app_handle().get_webview_window("player-controls") {
            let main = main.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(350)).await;
                let _ = player::attach_controls_window(&main, &controls);
            });
        }
        return Ok(());
    }
    if action == "controls_space" {
        state
            .player
            .set_controls_height(&window, value.unwrap_or(118.0))
            .await?;
        return Ok(());
    }
    if action == "stop" {
        crate::stop_playback(window.app_handle()).await;
        return Ok(());
    }
    if matches!(action.as_str(), "play_pause" | "pause") {
        let snapshot = state.player.cached_status();
        if let Some(file) = snapshot.file_id.filter(|_| snapshot.duration > 0.0) {
            state.store.save_playback_progress(
                &file,
                snapshot.position,
                snapshot.duration,
                snapshot.speed,
            )?;
        }
    }
    state.player.control(action, value).await?;
    // Reflect the change immediately instead of waiting for the next poll tick.
    let snapshot = state.player.status().await;
    let _ = window.app_handle().emit("nimbus-player-state", &snapshot);
    Ok(())
}

#[tauri::command]
pub(crate) fn player_current_file(state: State<'_, AppState>) -> Result<Option<MediaFile>> {
    state
        .player
        .current_file_id()
        .map(|file_id| state.store.get_media_file(&file_id))
        .transpose()
}

#[tauri::command]
pub(crate) async fn player_status(state: State<'_, AppState>) -> Result<player::PlayerStatus> {
    Ok(state.player.cached_status())
}

#[tauri::command]
pub(crate) fn player_playlist(state: State<'_, AppState>) -> Result<Vec<MediaFile>> {
    Ok(state.player.playlist())
}

/// Play through these files in order (a course): the video controls step and list by it.
#[tauri::command]
pub(crate) fn player_set_playlist(file_ids: Vec<String>, state: State<'_, AppState>) -> Result<()> {
    let files = file_ids.iter().filter_map(|id| state.store.get_media_file(id).ok()).collect();
    state.player.set_playlist(files);
    Ok(())
}
