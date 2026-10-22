//! SMB shares: a NAS, or a folder another Mac shares. macOS mounts the share (NetFS, as Finder does)
//! and Cove reads it like a local disk. Paths in the library stay relative to the share
//! ("/Movies/a.mkv"), so it does not matter where the share happens to be mounted.
use std::{
    ffi::{c_char, c_int, CString},
    path::{Component, Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use crate::{
    commands::accounts::account_token,
    error::{NimbusError, Result},
    local_storage,
    model::{CloudEntry, MediaFile, MediaSource, ScanResult},
    AppState,
};

unsafe extern "C" {
    fn nimbus_smb_mounted_at(path: *const c_char) -> c_int;
    fn nimbus_smb_mount(url: *const c_char, mountpath: *const c_char, user: *const c_char, password: *const c_char) -> c_int;
    fn nimbus_smb_unmount(path: *const c_char) -> c_int;
    fn nimbus_smb_find_mount(host: *const c_char, share: *const c_char, out: *mut c_char, length: usize) -> c_int;
}

/// Where Cove mounts shares itself: one folder per account under the app's data folder.
static MOUNTS: OnceLock<PathBuf> = OnceLock::new();
/// One mount attempt at a time, so a burst of opens does not mount a share twice.
static MOUNTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const MOUNT_TIMEOUT: Duration = Duration::from_secs(25);

pub fn init(data_dir: &Path) {
    let _ = MOUNTS.set(data_dir.join("Mounts"));
}

fn invalid(message: &str) -> NimbusError {
    NimbusError::Validation(message.into())
}

/// "nas.local/影视" or "smb://nas.local/影视/" → "smb://nas.local/%E5%BD%B1%E8%A7%86": a host and a
/// share, no credentials (those go in the fields and the Keychain).
pub fn normalize_url(input: &str) -> Result<String> {
    let trimmed = input.trim().trim_end_matches('/');
    let with_scheme = if trimmed.to_ascii_lowercase().starts_with("smb://") {
        trimmed.to_owned()
    } else {
        format!("smb://{trimmed}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| invalid("服务器地址无效，例如 smb://nas.local/影视"))?;
    let host = url.host_str().filter(|host| !host.is_empty()).ok_or_else(|| invalid("服务器地址缺少主机名，例如 smb://nas.local/影视"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("请把用户名和密码填在下面的栏里，不要写在地址中"));
    }
    let share = url
        .path_segments()
        .and_then(|mut segments| segments.next())
        .filter(|segment| !segment.is_empty())
        .ok_or_else(|| invalid("地址需要包含共享名称，例如 smb://nas.local/影视"))?;
    let port = url.port().map(|port| format!(":{port}")).unwrap_or_default();
    Ok(format!("smb://{host}{port}/{share}"))
}

/// The host and the (decoded) share name of a normalized address.
fn host_and_share(endpoint: &str) -> Option<(String, String)> {
    let url = url::Url::parse(endpoint).ok()?;
    let share = url.path_segments()?.next()?;
    let share = percent_encoding::percent_decode_str(share).decode_utf8().ok()?.into_owned();
    Some((url.host_str()?.to_owned(), share))
}

fn own_mount_point(account_id: &str) -> Result<PathBuf> {
    let base = MOUNTS.get().ok_or_else(|| NimbusError::Internal("SMB 尚未初始化".into()))?;
    Ok(base.join(format!("{:x}", md5::compute(account_id)).chars().take(12).collect::<String>()))
}

fn c_string(value: &str) -> Result<CString> {
    CString::new(value).map_err(|_| invalid("地址或账号包含无效字符"))
}

fn is_mounted(path: &Path) -> bool {
    c_string(&path.to_string_lossy()).is_ok_and(|path| unsafe { nimbus_smb_mounted_at(path.as_ptr()) } == 1)
}

/// The share already mounted by Finder (or anyone), if it is.
fn existing_mount(endpoint: &str) -> Option<PathBuf> {
    let (host, share) = host_and_share(endpoint)?;
    let (host, share) = (c_string(&host).ok()?, c_string(&share).ok()?);
    let mut buffer = vec![0 as c_char; 1024];
    let found = unsafe { nimbus_smb_find_mount(host.as_ptr(), share.as_ptr(), buffer.as_mut_ptr(), buffer.len()) };
    (found == 1).then(|| PathBuf::from(unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().into_owned()))
}

/// What a NetFS error means for the person connecting.
pub fn describe_error(code: i32) -> String {
    match code {
        80 => "用户名或密码不正确".into(),
        1 | 13 => "没有访问这个共享的权限".into(),
        2 => "找不到这个共享，请检查共享名称".into(),
        51 | 60 | 61 | 64 | 65 => "无法连接服务器，请确认它已开机并与这台 Mac 在同一网络中".into(),
        -6004 => "这台服务器不允许访客访问，请填写用户名和密码".into(),
        -6003 => "服务器上没有可用的共享".into(),
        _ => format!("无法连接共享（错误 {code}）"),
    }
}

/// Mount `endpoint` at `mountpath`; a missing user signs in as guest.
async fn mount(endpoint: &str, mountpath: &Path, user: &str, password: &str) -> Result<()> {
    std::fs::create_dir_all(mountpath)?;
    let url = c_string(endpoint)?;
    let path = c_string(&mountpath.to_string_lossy())?;
    let user = c_string(user)?;
    // The password crosses into C as a NUL-terminated buffer that is wiped afterwards.
    if password.contains('\0') {
        return Err(invalid("密码包含无效字符"));
    }
    let mut secret = zeroize::Zeroizing::new(password.as_bytes().to_vec());
    secret.push(0);
    let attempt = tokio::task::spawn_blocking(move || unsafe {
        nimbus_smb_mount(url.as_ptr(), path.as_ptr(), user.as_ptr(), secret.as_ptr().cast::<c_char>())
    });
    let code = tokio::time::timeout(MOUNT_TIMEOUT, attempt)
        .await
        .map_err(|_| invalid("连接共享超时，请确认服务器已开机并与这台 Mac 在同一网络中"))?
        .map_err(|error| NimbusError::Internal(error.to_string()))?;
    if code != 0 {
        return Err(NimbusError::Validation(describe_error(code)));
    }
    Ok(())
}

/// Check new connection details by mounting with them; used when adding or reconnecting a share.
pub async fn connect(account_id: &str, endpoint: &str, user: &str, password: &str) -> Result<()> {
    let _guard = MOUNTING.lock().await;
    let root = own_mount_point(account_id)?;
    if is_mounted(&root) {
        let path = c_string(&root.to_string_lossy())?;
        unsafe { nimbus_smb_unmount(path.as_ptr()) };
    }
    mount(endpoint, &root, user, password).await
}

/// The folder the share is mounted at, mounting it first when needed.
pub async fn ensure_mounted(state: &AppState, account_id: &str) -> Result<PathBuf> {
    let root = own_mount_point(account_id)?;
    if is_mounted(&root) {
        return Ok(root);
    }
    let _guard = MOUNTING.lock().await;
    if is_mounted(&root) {
        return Ok(root);
    }
    let (stored, password) = account_token(account_id, state).await?;
    // Finder may have mounted this share already; macOS will not mount it twice for one user.
    if let Some(existing) = existing_mount(&stored.account.endpoint) {
        return Ok(existing);
    }
    mount(&stored.account.endpoint, &root, stored.account.username.as_deref().unwrap_or_default(), &password).await?;
    Ok(root)
}

/// Unmount Cove's own mount of a removed share (a share Finder mounted is left alone).
pub fn forget(account_id: &str) {
    if let Ok(root) = own_mount_point(account_id) {
        if is_mounted(&root) {
            if let Ok(path) = c_string(&root.to_string_lossy()) {
                unsafe { nimbus_smb_unmount(path.as_ptr()) };
            }
        }
        let _ = std::fs::remove_dir(root);
    }
}

/// "/Movies/a.mkv" inside the share → the file in the mounted folder. Nothing outside the share.
pub fn to_local(root: &Path, path: &str) -> Result<PathBuf> {
    let relative = Path::new(path.trim_start_matches('/'));
    if relative.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(invalid("路径无效"));
    }
    Ok(root.join(relative))
}

/// A path in the mounted folder → the same path inside the share ("/Movies/a.mkv").
pub fn to_share(root: &Path, local: &str) -> Option<String> {
    let rest = Path::new(local).strip_prefix(root).ok()?;
    Some(format!("/{}", rest.to_string_lossy()).replace("//", "/"))
}

/// One folder of the share, with paths inside the share.
pub async fn browse(state: &AppState, account_id: &str, path: &str) -> Result<Vec<CloudEntry>> {
    let root = ensure_mounted(state, account_id).await?;
    let local = to_local(&root, path)?;
    let entries = tokio::task::spawn_blocking(move || local_storage::browse(&local.to_string_lossy()))
        .await
        .map_err(|error| NimbusError::Internal(error.to_string()))??;
    Ok(entries
        .into_iter()
        .filter_map(|mut entry| {
            entry.path = to_share(&root, &entry.path)?;
            entry.id = entry.path.clone();
            Some(entry)
        })
        .collect())
}

/// Scan a media folder of the share like a local one, keeping paths inside the share.
pub async fn scan(state: &AppState, source: &MediaSource) -> Result<(Vec<MediaFile>, ScanResult)> {
    let root = ensure_mounted(state, &source.account_id).await?;
    let local = to_local(&root, &source.remote_root)?;
    let (account_id, kind) = (source.account_id.clone(), source.kind.clone());
    let (mut files, mut result) = tokio::task::spawn_blocking(move || {
        local_storage::scan_root(&account_id, &local.to_string_lossy(), &kind, 20_000)
    })
    .await
    .map_err(|error| NimbusError::Internal(format!("扫描任务失败：{error}")))??;
    for file in &mut files {
        if let Some(path) = to_share(&root, &file.remote_path) {
            file.cloud_path = Some(path.clone());
            file.remote_path = path;
        }
    }
    for folder in &mut result.skipped_directories {
        if let Some(path) = to_share(&root, folder) {
            *folder = path;
        }
    }
    Ok((files, result))
}

/// The local file for a path inside the share, mounting the share if needed.
pub async fn local_file(state: &AppState, account_id: &str, path: &str) -> Result<PathBuf> {
    let root = ensure_mounted(state, account_id).await?;
    to_local(&root, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_name_a_host_and_a_share_without_credentials() {
        assert_eq!(normalize_url("smb://nas.local/Media/").unwrap(), "smb://nas.local/Media");
        assert_eq!(normalize_url("nas.local/Media/Movies").unwrap(), "smb://nas.local/Media");
        assert_eq!(normalize_url("SMB://192.168.1.5:4445/share").unwrap(), "smb://192.168.1.5:4445/share");
        assert_eq!(normalize_url("smb://nas.local/影视").unwrap(), "smb://nas.local/%E5%BD%B1%E8%A7%86");
        assert!(normalize_url("smb://nas.local").is_err());
        assert!(normalize_url("smb://me:secret@nas.local/Media").is_err());
        assert!(normalize_url("smb:///Media").is_err());
        assert_eq!(host_and_share("smb://nas.local/%E5%BD%B1%E8%A7%86"), Some(("nas.local".into(), "影视".into())));
    }

    #[test]
    fn paths_stay_inside_the_share() {
        let root = Path::new("/Users/me/Library/Application Support/app.cove.desktop/Mounts/abc");
        assert_eq!(to_local(root, "/Movies/a.mkv").unwrap(), root.join("Movies/a.mkv"));
        assert_eq!(to_local(root, "/").unwrap(), root.to_path_buf());
        assert!(to_local(root, "/../../etc/passwd").is_err());
        assert!(to_local(root, "/Movies/../../a.mkv").is_err());
        assert_eq!(to_local(root, "/Movies/./a.mkv").unwrap(), root.join("Movies/a.mkv"));
        assert_eq!(to_share(root, &root.join("Movies/a.mkv").to_string_lossy()).as_deref(), Some("/Movies/a.mkv"));
        assert_eq!(to_share(root, &root.to_string_lossy()).as_deref(), Some("/"));
        assert_eq!(to_share(root, "/elsewhere/a.mkv"), None);
    }

    #[test]
    fn errors_say_what_to_check() {
        assert_eq!(describe_error(80), "用户名或密码不正确");
        assert!(describe_error(61).contains("无法连接服务器"));
        assert!(describe_error(-6004).contains("访客"));
        assert!(describe_error(12345).contains("12345"));
    }
}

#[cfg(test)]
mod native_tests {
    use super::*;

    /// Talks to macOS NetFS: run by hand with `cargo test smb_native -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn smb_native_unreachable_server_fails_fast_without_ui() {
        let directory = std::env::temp_dir().join(format!("cove-smb-{}", uuid::Uuid::new_v4()));
        let started = std::time::Instant::now();
        let error = mount("smb://127.0.0.1:1/share", &directory, "", "").await.unwrap_err();
        println!("error after {:?}: {error}", started.elapsed());
        assert!(started.elapsed() < MOUNT_TIMEOUT);
        assert!(!is_mounted(&directory));
        assert_eq!(existing_mount("smb://127.0.0.1:1/share"), None);
        let _ = std::fs::remove_dir(directory);
    }
}
