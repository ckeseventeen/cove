use super::super::*;

const VIDEO_EXTS: &[&str] = &[
    "mkv", "mp4", "m4v", "mov", "avi", "webm", "ts", "m2ts", "flv", "wmv",
];
const AUDIO_EXTS: &[&str] = &["mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "ape"];

#[tauri::command]
pub(crate) async fn storage_play_file(
    account_id: String,
    path: String,
    name: String,
    entry_id: Option<String>,
    siblings: Option<Vec<CloudEntry>>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<String> {
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    let media_kind = if VIDEO_EXTS.contains(&extension.as_str()) {
        "movie"
    } else if AUDIO_EXTS.contains(&extension.as_str()) {
        "music"
    } else {
        return Err(NimbusError::Validation("不支持直接播放该格式文件".into()));
    };

    let size = if account_id == "local"
        || (path.starts_with('/') && !path.contains("://") && std::path::Path::new(&path).exists())
    {
        std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let (remote_path, cloud_path) = if account_id == "local" {
        (path.clone(), path.clone())
    } else {
        let account = state.store.get_account(&account_id)?;
        if account.account.provider == "baidu" {
            let fs_id = if let Some(ref id) =
                entry_id.filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
            {
                id.clone()
            } else if let Some(id) = path.strip_prefix("baidu://") {
                id.to_string()
            } else {
                let parent_dir = std::path::Path::new(&path)
                    .parent()
                    .and_then(|p| p.to_str())
                    .unwrap_or("/");
                let parent = if parent_dir.is_empty() {
                    "/"
                } else {
                    parent_dir
                };
                let (_, token) = commands::accounts::account_token(&account_id, &state).await?;
                let items = direct::browse("baidu", &token, parent)
                    .await
                    .unwrap_or_default();
                items
                    .into_iter()
                    .find(|e| e.name == name || e.path == path)
                    .map(|e| e.id)
                    .unwrap_or_default()
            };

            if fs_id.is_empty() {
                return Err(NimbusError::Validation(
                    "未能获取百度网盘文件信息，请刷新后重试".into(),
                ));
            }
            (format!("baidu://{fs_id}"), path.clone())
        } else if account.account.provider == "google_drive" {
            let id = entry_id.unwrap_or_default();
            (
                format!("https://www.googleapis.com/drive/v3/files/{id}?alt=media&supportsAllDrives=true"),
                path.clone(),
            )
        } else if account.account.provider == "onedrive" {
            let id = entry_id.unwrap_or_default();
            (
                format!("https://graph.microsoft.com/v1.0/me/drive/items/{id}/content"),
                path.clone(),
            )
        } else {
            (path.clone(), path.clone())
        }
    };

    let file_id = state.store.ensure_media_file(
        &account_id,
        &remote_path,
        Some(&cloud_path),
        &name,
        media_kind,
        size,
    )?;

    // If siblings are provided, register them and update the player's active playlist
    let mut playlist_files = Vec::new();
    if let Some(entries) = siblings {
        for entry in entries {
            if entry.is_dir {
                continue;
            }
            let ext = entry
                .name
                .rsplit_once('.')
                .map(|(_, ext)| ext.to_ascii_lowercase())
                .unwrap_or_default();
            if !VIDEO_EXTS.contains(&ext.as_str()) && !AUDIO_EXTS.contains(&ext.as_str()) {
                continue;
            }
            let sib_kind = if VIDEO_EXTS.contains(&ext.as_str()) {
                "movie"
            } else {
                "music"
            };
            let (sib_remote, sib_cloud) = if account_id == "local" {
                (entry.path.clone(), entry.path.clone())
            } else if let Ok(ref acc) = state.store.get_account(&account_id) {
                if acc.account.provider == "baidu" {
                    if !entry.id.is_empty() && entry.id.chars().all(|c| c.is_ascii_digit()) {
                        (format!("baidu://{}", entry.id), entry.path.clone())
                    } else {
                        (entry.path.clone(), entry.path.clone())
                    }
                } else if acc.account.provider == "google_drive" {
                    (
                        format!("https://www.googleapis.com/drive/v3/files/{}?alt=media&supportsAllDrives=true", entry.id),
                        entry.path.clone(),
                    )
                } else if acc.account.provider == "onedrive" {
                    (
                        format!(
                            "https://graph.microsoft.com/v1.0/me/drive/items/{}/content",
                            entry.id
                        ),
                        entry.path.clone(),
                    )
                } else {
                    (entry.path.clone(), entry.path.clone())
                }
            } else {
                (entry.path.clone(), entry.path.clone())
            };

            if let Ok(sib_id) = state.store.ensure_media_file(
                &account_id,
                &sib_remote,
                Some(&sib_cloud),
                &entry.name,
                sib_kind,
                entry.size,
            ) {
                if let Ok(media_file) = state.store.get_media_file(&sib_id) {
                    playlist_files.push(media_file);
                }
            }
        }
    }

    state.player.set_playlist(playlist_files);

    commands::playback::player_open_native(file_id.clone(), Some(false), window, state).await?;
    Ok(file_id)
}

fn existing_local_path(path: &str) -> Result<std::path::PathBuf> {
    let path = std::path::Path::new(path);
    if !path.is_absolute() {
        return Err(NimbusError::Validation("需要本机绝对路径".into()));
    }
    path.canonicalize()
        .map_err(|error| NimbusError::Validation(format!("文件不存在或无法访问：{error}")))
}

async fn open_local(path: String, reveal: bool) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let path = existing_local_path(&path)?;
        let mut command = std::process::Command::new("/usr/bin/open");
        if reveal {
            command.arg("-R");
        }
        let status = command.arg(path).status()?;
        if !status.success() {
            return Err(NimbusError::Validation("系统应用未能打开该文件".into()));
        }
        Ok(())
    })
    .await
    .map_err(|error| NimbusError::Internal(error.to_string()))?
}

#[tauri::command]
pub(crate) async fn open_native_path(path: String) -> Result<()> {
    open_local(path, false).await
}
#[tauri::command]
pub(crate) async fn reveal_native_path(path: String) -> Result<()> {
    open_local(path, true).await
}

fn text_preview(path: &str) -> Result<String> {
    use std::io::Read;
    const LIMIT: u64 = 5 * 1024 * 1024;
    let path = existing_local_path(path)?;
    let file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(NimbusError::Validation("只能预览普通文件".into()));
    }
    if metadata.len() > LIMIT {
        return Err(NimbusError::Validation(
            "文件大于 5MB，请使用系统默认应用打开".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        return Err(NimbusError::Validation(
            "文件读取期间变大，请使用系统默认应用打开".into(),
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        NimbusError::Validation("该文件不是 UTF-8 文本内容，请使用系统默认应用打开".into())
    })
}
#[tauri::command]
pub(crate) async fn read_text_preview(path: String) -> Result<String> {
    tokio::task::spawn_blocking(move || text_preview(&path))
        .await
        .map_err(|error| NimbusError::Internal(error.to_string()))?
}

#[cfg(test)]
mod file_flow_tests {
    use super::*;
    #[test]
    fn preview_text_and_reject_unsupported_files() {
        let root = std::env::temp_dir().join(format!("cove-preview-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("note.txt");
        std::fs::write(&file, "个人 Space\n测试文档").unwrap();
        assert_eq!(
            text_preview(file.to_str().unwrap()).unwrap(),
            "个人 Space\n测试文档"
        );
        assert!(text_preview(root.to_str().unwrap()).is_err());
        std::fs::write(&file, [0xff, 0xfe]).unwrap();
        assert!(text_preview(file.to_str().unwrap()).is_err());
        let large = std::fs::File::create(&file).unwrap();
        large.set_len(5 * 1024 * 1024 + 1).unwrap();
        assert!(text_preview(file.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn system_open_requires_existing_absolute_file() {
        assert!(existing_local_path("https://example.com").is_err());
        assert!(existing_local_path("-a").is_err());
        assert!(existing_local_path("/this-file-must-not-exist-cove-test").is_err());
    }
}
