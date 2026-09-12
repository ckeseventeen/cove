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
    let main = window
        .app_handle()
        .get_webview_window("main")
        .unwrap_or_else(|| window.clone());
    state.player.cancel_pending_open();
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
    let (mut position, speed) = state
        .store
        .playback_progress(&file_id)?
        .unwrap_or((0.0, 1.0));
    if from_start.unwrap_or(false) {
        position = 0.0;
    }
    let account = state.store.get_account(&file.account_id)?;
    let show_video = file.media_kind.as_deref() != Some("music");
    let url = if account.account.provider == "local" {
        file.remote_path.clone()
    } else {
        state.proxy.create_url(file_id.clone()).await
    };
    let opened = state
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
        .await;
    if let Err(error) = opened {
        if state.player.current_file_id().is_none() {
            state.player.set_view_visible(&main, false).await?;
            if let Some(controls) = window.app_handle().get_webview_window("player-controls") {
                let _ = controls.hide();
            }
        }
        return Err(error);
    }
    let snapshot = state.player.status().await;
    let _ = window.app_handle().emit("nimbus-player-state", &snapshot);
    if let Some(controls) = window.app_handle().get_webview_window("player-controls") {
        if show_video {
            player::attach_controls_window(&main, &controls)?;
            let _ = controls.show();
            let _ = main.set_focus();
        } else {
            let _ = controls.hide();
            let _ = player::detach_controls_window(&controls);
            let _ = main.set_focus();
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn player_control(
    action: String,
    value: Option<f64>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<()> {
    if action == "fullscreen" {
        let main = window
            .app_handle()
            .get_webview_window("main")
            .unwrap_or_else(|| window.clone());
        let fullscreen = main
            .is_fullscreen()
            .map_err(|error| NimbusError::Internal(error.to_string()))?;
        main.set_fullscreen(!fullscreen)
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
    let should_hide = action == "stop";
    if should_hide {
        state.player.cancel_pending_open();
    }
    if matches!(action.as_str(), "stop" | "play_pause") {
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
    if should_hide {
        state.proxy.revoke_all().await;
        let _ = window
            .app_handle()
            .emit("nimbus-player-state", state.player.cached_status());
        let _ = window.app_handle().emit("nimbus-player-stopped", ());
        let main = window
            .app_handle()
            .get_webview_window("main")
            .unwrap_or_else(|| window.clone());
        state.player.set_view_visible(&main, false).await?;
        if let Some(controls) = window.app_handle().get_webview_window("player-controls") {
            let _ = controls.hide();
            let _ = player::detach_controls_window(&controls);
        }
    }
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

#[tauri::command]
pub(crate) async fn player_add_subtitle(
    path: String,
    title: Option<String>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<()> {
    state.player.add_subtitle(&path, title.as_deref()).await?;
    let snapshot = state.player.status().await;
    let _ = window.app_handle().emit("nimbus-player-state", &snapshot);
    Ok(())
}
