use super::super::*;
use super::accounts::account_token;

#[tauri::command]
pub(crate) async fn entry_copy(
    source_account_id: String,
    source_path: String,
    source_entry_id: String,
    source_is_dir: bool,
    destination_account_id: String,
    destination_path: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let source = state.store.get_account(&source_account_id)?;
    let destination = state.store.get_account(&destination_account_id)?;
    match (
        source.account.provider.as_str(),
        destination.account.provider.as_str(),
    ) {
        ("local", "local") => {
            tokio::task::spawn_blocking(move || {
                local_storage::copy_entry(&source_path, &destination_path)
            })
            .await
            .map_err(|error| NimbusError::Internal(format!("本地复制任务失败：{error}")))??;
            Ok(())
        }
        ("baidu", "baidu") if source_account_id == destination_account_id => {
            let (_, token) = account_token(&source_account_id, &state).await?;
            direct::copy_baidu(&token, &source_path, &destination_path).await
        }
        ("baidu", "local") => {
            let (_, token) = account_token(&source_account_id, &state).await?;
            let name = source_path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or("百度网盘文件");
            let target = local_storage::destination_for_new_entry(&destination_path, name)?;
            direct::download_baidu_entry(
                &token,
                &source_path,
                source_entry_id.parse().ok(),
                source_is_dir,
                target,
            )
            .await
        }
        ("local", "baidu") => {
            let (_, token) = account_token(&destination_account_id, &state).await?;
            direct::upload_baidu_entry(
                &token,
                std::path::Path::new(&source_path),
                &destination_path,
            )
            .await
        }
        _ => Err(NimbusError::Validation(
            "当前版本暂不支持这两个存储源之间复制".into(),
        )),
    }
}

#[tauri::command]
pub(crate) async fn folder_create(
    account_id: String,
    parent_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let name = name.trim().to_owned();
    if name.is_empty() || matches!(name.as_str(), "." | "..") || name.contains(['/', '\0']) {
        return Err(NimbusError::Validation("文件夹名称无效".into()));
    }
    let account = state.store.get_account(&account_id)?;
    match account.account.provider.as_str() {
        "local" => {
            tokio::task::spawn_blocking(move || local_storage::create_folder(&parent_path, &name))
                .await
                .map_err(|error| NimbusError::Internal(format!("新建目录任务失败：{error}")))??;
            Ok(())
        }
        "baidu" => {
            let (_, token) = account_token(&account_id, &state).await?;
            direct::create_baidu_folder(&token, &parent_path, &name).await?;
            Ok(())
        }
        _ => Err(NimbusError::Validation(
            "这个存储源暂不支持新建文件夹".into(),
        )),
    }
}
