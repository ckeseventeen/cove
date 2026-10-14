//! Documents: open PDFs in the native reader and remember the page reached.
use std::{
    ffi::{c_char, c_int, CStr, CString},
    path::{Path, PathBuf},
    sync::OnceLock,
};

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{
    commands::accounts::account_token,
    error::{NimbusError, Result},
    model::ReadingProgress,
    AppState,
};

unsafe extern "C" {
    fn nimbus_pdf_install(callback: extern "C" fn(*const c_char, c_int, c_int));
    fn nimbus_pdf_open(path: *const c_char, title: *const c_char, key: *const c_char, page: c_int);
}

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn install(app: AppHandle) {
    if APP.set(app).is_ok() {
        unsafe { nimbus_pdf_install(on_page_changed) };
    }
}

extern "C" fn on_page_changed(key: *const c_char, page: c_int, page_count: c_int) {
    let Some(app) = APP.get() else {
        return;
    };
    if key.is_null() {
        return;
    }
    let key = unsafe { CStr::from_ptr(key) }.to_string_lossy().into_owned();
    let state = app.state::<AppState>();
    if state
        .store
        .save_reading_page(&key, page.max(0) as u32, page_count.max(0) as u32)
        .is_ok()
    {
        if let Ok(Some(progress)) = state.store.reading_progress(&key) {
            let _ = app.emit("reading-progress", progress);
        }
    }
}

/// The identity used to remember a document: the same file reached from the library or from Files.
fn document_key(account_id: &str, path: &str) -> String {
    format!("{account_id}:{path}")
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| if matches!(character, '/' | '\\' | ':' | '\0') { '_' } else { character })
        .collect();
    let trimmed = cleaned.trim_start_matches('.').trim();
    if trimmed.is_empty() {
        "document.pdf".into()
    } else {
        trimmed.chars().take(120).collect()
    }
}

async fn looks_like_pdf(path: &Path) -> bool {
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return false;
    };
    let mut head = vec![0u8; 1024];
    let Ok(read) = file.read(&mut head).await else {
        return false;
    };
    head[..read].windows(5).any(|window| window == b"%PDF-")
}

async fn download(request: reqwest::RequestBuilder, target: &Path) -> Result<()> {
    let mut response = request.send().await?.error_for_status()?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = target.with_extension("cove-download");
    let mut output = tokio::fs::File::create(&temporary).await?;
    let result = async {
        while let Some(chunk) = response.chunk().await? {
            output.write_all(&chunk).await?;
        }
        output.flush().await?;
        Ok::<_, NimbusError>(())
    }
    .await;
    drop(output);
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    tokio::fs::rename(&temporary, target).await?;
    Ok(())
}

/// Where downloaded copies of one account's documents are kept.
fn cache_dir(app: &AppHandle, account_id: &str) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| NimbusError::Internal(error.to_string()))?
        .join("documents")
        .join(format!("{:x}", md5::compute(account_id))))
}

/// Delete the downloaded copies of a removed account's documents.
pub(crate) async fn remove_cached_copies(app: &AppHandle, account_id: &str) {
    if let Ok(cache) = cache_dir(app, account_id) {
        let _ = tokio::fs::remove_dir_all(cache).await;
    }
}

/// A local copy of the document: the file itself on this Mac, otherwise a cached download.
async fn local_copy(
    app: &AppHandle,
    state: &AppState,
    account_id: &str,
    path: &str,
    entry_id: &str,
    name: &str,
    size: u64,
) -> Result<PathBuf> {
    let stored = state.store.get_account(account_id)?;
    let provider = stored.account.provider.as_str();
    if provider == "local" {
        let file = PathBuf::from(path);
        if !file.is_absolute() || !file.is_file() {
            return Err(NimbusError::Validation("文件不存在或无法访问".into()));
        }
        return Ok(file);
    }

    let cache = cache_dir(app, account_id)?;
    let target = cache.join(format!("{:x}-{}", md5::compute(path), safe_file_name(name)));
    if let Ok(metadata) = tokio::fs::metadata(&target).await {
        if size == 0 || metadata.len() == size {
            return Ok(target);
        }
        let _ = tokio::fs::remove_file(&target).await;
    }

    let (stored, token) = account_token(account_id, state).await?;
    match provider {
        "baidu" => {
            let fs_id = entry_id
                .trim_start_matches("baidu://")
                .parse::<u64>()
                .map_err(|_| NimbusError::Validation("百度文件缺少文件标识".into()))?;
            tokio::fs::create_dir_all(&cache).await?;
            crate::direct::download_baidu_entry(&token, path, Some(fs_id), false, target.clone())
                .await?;
        }
        "webdav" => {
            let base = url::Url::parse(&stored.account.endpoint)?;
            let url = url::Url::parse(entry_id)?;
            if url.origin() != base.origin() {
                return Err(NimbusError::Validation("文件不属于这个 WebDAV 来源".into()));
            }
            let request = crate::http_client::transfer_http()
                .get(url)
                .basic_auth(stored.account.username.as_deref().unwrap_or_default(), Some(&token));
            download(request, &target).await?;
        }
        "google_drive" | "onedrive" => {
            let url = if entry_id.starts_with("https://") {
                entry_id.to_owned()
            } else if provider == "google_drive" {
                format!("https://www.googleapis.com/drive/v3/files/{entry_id}?alt=media&supportsAllDrives=true")
            } else {
                format!("https://graph.microsoft.com/v1.0/me/drive/items/{entry_id}/content")
            };
            let parsed = url::Url::parse(&url)?;
            if parsed.scheme() != "https"
                || !matches!(parsed.host_str(), Some("www.googleapis.com" | "graph.microsoft.com"))
            {
                return Err(NimbusError::Validation("文件地址无效".into()));
            }
            download(crate::http_client::transfer_http().get(parsed).bearer_auth(&token), &target)
                .await?;
        }
        _ => return Err(NimbusError::Validation("这个存储位置暂不支持打开文档".into())),
    }
    Ok(target)
}

async fn open(
    app: &AppHandle,
    state: &AppState,
    account_id: String,
    path: String,
    entry_id: String,
    name: String,
    size: u64,
) -> Result<ReadingProgress> {
    if !crate::media_types::is_document(&name) {
        return Err(NimbusError::Validation("目前只能阅读 PDF 文档".into()));
    }
    let file = local_copy(app, state, &account_id, &path, &entry_id, &name, size).await?;
    if !looks_like_pdf(&file).await {
        return Err(NimbusError::Validation("这个文件不是有效的 PDF".into()));
    }
    let progress = state.store.touch_reading_document(&ReadingProgress {
        doc_key: document_key(&account_id, &path),
        account_id,
        path,
        entry_id,
        name,
        size,
        page: 0,
        page_count: 0,
        updated_at: 0,
    })?;
    let text = |value: &str| CString::new(value.replace('\0', "")).unwrap_or_default();
    let (file, title, key) = (
        text(&file.to_string_lossy()),
        text(progress.name.trim_end_matches(".pdf").trim_end_matches(".PDF")),
        text(&progress.doc_key),
    );
    unsafe { nimbus_pdf_open(file.as_ptr(), title.as_ptr(), key.as_ptr(), progress.page as c_int) };
    let _ = app.emit("reading-progress", &progress);
    Ok(progress)
}

/// Open a PDF found while browsing a storage location.
#[tauri::command]
pub(crate) async fn document_open(
    account_id: String,
    path: String,
    entry_id: Option<String>,
    name: String,
    size: Option<u64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ReadingProgress> {
    let entry_id = entry_id.filter(|value| !value.is_empty()).unwrap_or_else(|| path.clone());
    open(&app, &state, account_id, path, entry_id, name, size.unwrap_or(0)).await
}

/// Open a PDF from the documents library.
#[tauri::command]
pub(crate) async fn document_open_file(
    file_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ReadingProgress> {
    let file = state.store.get_media_file(&file_id)?;
    let path = file.cloud_path.clone().unwrap_or_else(|| file.remote_path.clone());
    open(&app, &state, file.account_id, path, file.remote_path, file.display_name, file.size).await
}

#[tauri::command]
pub(crate) fn document_progress_list(state: State<'_, AppState>) -> Result<Vec<ReadingProgress>> {
    state.store.list_reading_progress(200)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_names_cannot_escape_the_cache_directory() {
        assert_eq!(safe_file_name("../../etc/passwd.pdf"), "_.._etc_passwd.pdf");
        assert_eq!(safe_file_name("..."), "document.pdf");
        assert_eq!(safe_file_name("年度报告.pdf"), "年度报告.pdf");
    }

    #[test]
    fn library_and_browser_share_one_memory_key() {
        assert_eq!(document_key("local", "/Books/a.pdf"), "local:/Books/a.pdf");
    }
}
