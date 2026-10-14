use super::super::*;
use super::accounts::account_token;

#[tauri::command]
pub(crate) fn playback_recent(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>> {
    state.store.recent_playback()
}
#[tauri::command]
pub(crate) fn metadata_cached_movies(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, serde_json::Value>> {
    super::metadata::launch_movies(&state.store)
}
#[tauri::command]
pub(crate) fn metadata_cache_clear(state: State<'_, AppState>) -> Result<()> {
    state.store.clear_metadata()
}

#[tauri::command]
pub(crate) fn app_status(state: State<'_, AppState>) -> Result<AppStatus> {
    let account_count = state.store.list_accounts()?.len();
    Ok(AppStatus {
        platform: "macOS".into(),
        database_ready: true,
        account_count,
        baidu_configured: config::BaiduConfig::load().is_ok(),
        tmdb_configured: config::TmdbConfig::load().is_ok(),
        mpv_available: true, // libmpv is linked; load failure prevents startup.
    })
}

#[tauri::command]
pub(crate) fn media_file_list(state: State<'_, AppState>) -> Result<Vec<MediaFile>> {
    state.store.list_media_files()
}

#[tauri::command]
pub(crate) fn media_source_list(state: State<'_, AppState>) -> Result<Vec<MediaSource>> {
    state.store.list_media_sources()
}

#[tauri::command]
pub(crate) fn media_source_add(
    account_id: String,
    kind: String,
    remote_root: String,
    label: String,
    state: State<'_, AppState>,
) -> Result<MediaSource> {
    if !matches!(kind.as_str(), "movie" | "music" | "document") {
        return Err(NimbusError::Validation("媒体类型只能是影视、音乐或文档".into()));
    }
    state.store.get_account(&account_id)?;
    // "/电影/" and "/电影" are one folder; keep one spelling so it can only be added once.
    let remote_root = match remote_root.trim().trim_end_matches('/') {
        "" => "/".to_owned(),
        root => root.to_owned(),
    };
    if remote_root == "/" {
        return Err(NimbusError::Validation(
            "不能把整个网盘设为媒体库，请选择具体文件夹".into(),
        ));
    }
    let source = MediaSource {
        id: Uuid::new_v4().to_string(),
        account_id,
        kind,
        remote_root,
        label: label.trim().to_owned(),
        last_scan_at: None,
    };
    state.store.insert_media_source(&source)?;
    Ok(source)
}

#[tauri::command]
pub(crate) fn media_source_remove(source_id: String, state: State<'_, AppState>) -> Result<()> {
    state.store.delete_media_source(&source_id)
}

#[tauri::command]
pub(crate) async fn media_source_scan(
    source_id: String,
    state: State<'_, AppState>,
) -> Result<ScanResult> {
    let source = state.store.get_media_source(&source_id)?;
    if source.remote_root == "/" {
        return Err(NimbusError::Validation(
            "为避免遍历整个网盘，根目录不能扫描。请移除这个来源，再选择具体的影视或音乐文件夹。"
                .into(),
        ));
    }
    let stored = state.store.get_account(&source.account_id)?;
    let (mut files, mut result) = if stored.account.provider == "local" {
        let account_id = stored.account.id.clone();
        let root = source.remote_root.clone();
        let kind = source.kind.clone();
        tokio::task::spawn_blocking(move || {
            local_storage::scan_root(&account_id, &root, &kind, 20_000)
        })
        .await
        .map_err(|error| NimbusError::Internal(format!("本地扫描任务失败：{error}")))??
    } else {
        let (_, token) = account_token(&source.account_id, &state).await?;
        if stored.account.provider == "webdav" {
            webdav::scan(
                &stored.account.id,
                &stored.account.endpoint,
                &source.remote_root,
                stored.account.username.as_deref().unwrap_or_default(),
                &token,
                64,
                20_000,
                &source.kind,
            )
            .await?
        } else {
            tokio::time::timeout(
                Duration::from_secs(180),
                direct::scan_root(
                    &stored.account.provider,
                    &stored.account.id,
                    &token,
                    &source.remote_root,
                    &source.kind,
                    5_000,
                ),
            )
            .await
            .map_err(|_| {
                NimbusError::Validation("扫描超过 3 分钟，已停止，原有索引保留".into())
            })??
        }
    };
    // Folders the scan could not read keep what they had, and the scan still counts as complete.
    if !result.skipped_directories.is_empty() {
        local_storage::keep_skipped(
            &mut files,
            state.store.list_media_files()?,
            &source.id,
            &result.skipped_directories,
        );
        result.media_files = files.len();
    }
    for file in &mut files {
        file.source_id = Some(source.id.clone());
        file.media_kind = Some(source.kind.clone());
    }
    state
        .store
        .replace_source_files(&source, &files, !result.truncated)?;
    Ok(result)
}

fn playlist_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(NimbusError::Validation("播放列表名称不能为空".into()));
    }
    Ok(name.chars().take(100).collect())
}

#[tauri::command]
pub(crate) fn playlist_list(state: State<'_, AppState>) -> Result<Vec<model::Playlist>> {
    state.store.list_playlists()
}

#[tauri::command]
pub(crate) fn playlist_create(
    name: String,
    file_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<model::Playlist> {
    let id = Uuid::new_v4().to_string();
    state.store.create_playlist(&id, &playlist_name(&name)?, &file_ids)?;
    state
        .store
        .list_playlists()?
        .into_iter()
        .find(|playlist| playlist.id == id)
        .ok_or_else(|| NimbusError::Internal("播放列表创建失败".into()))
}

#[tauri::command]
pub(crate) fn playlist_rename(id: String, name: String, state: State<'_, AppState>) -> Result<()> {
    state.store.rename_playlist(&id, &playlist_name(&name)?)
}

#[tauri::command]
pub(crate) fn playlist_delete(id: String, state: State<'_, AppState>) -> Result<()> {
    state.store.delete_playlist(&id)
}

#[tauri::command]
pub(crate) fn playlist_set_items(
    id: String,
    file_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    state.store.set_playlist_items(&id, &file_ids)
}
