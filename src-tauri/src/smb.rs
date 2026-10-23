//! SMB shares: a NAS, or a folder another computer shares. macOS mounts the share (NetFS, as Finder
//! does); Windows opens it by its network path (\\nas\share), signing in as Explorer does. Either
//! way Cove reads it like a local disk. Paths in the library stay relative to the share
//! ("/Movies/a.mkv"), so it does not matter where the share happens to be reached.
use std::{
    path::{Component, Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use crate::{
    error::{NimbusError, Result},
    local_storage,
    model::{CloudEntry, MediaFile, MediaSource, ScanResult},
    AppState,
};

pub use mount::{connect, ensure_mounted, forget};

/// Where Cove mounts shares itself on macOS: one folder per account under the app's data folder.
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

/// What a NetFS error means for the person connecting.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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

#[cfg(target_os = "macos")]
mod mount {
    use std::ffi::{c_char, c_int, CString};

    use super::*;
    use crate::commands::accounts::account_token;

    unsafe extern "C" {
        fn nimbus_smb_mounted_at(path: *const c_char) -> c_int;
        fn nimbus_smb_mount(url: *const c_char, mountpath: *const c_char, user: *const c_char, password: *const c_char) -> c_int;
        fn nimbus_smb_unmount(path: *const c_char) -> c_int;
        fn nimbus_smb_find_mount(host: *const c_char, share: *const c_char, out: *mut c_char, length: usize) -> c_int;
    }

    fn own_mount_point(account_id: &str) -> Result<PathBuf> {
        let base = MOUNTS.get().ok_or_else(|| NimbusError::Internal("SMB 尚未初始化".into()))?;
        Ok(base.join(format!("{:x}", md5::compute(account_id)).chars().take(12).collect::<String>()))
    }

    fn c_string(value: &str) -> Result<CString> {
        CString::new(value).map_err(|_| invalid("地址或账号包含无效字符"))
    }

    pub(super) fn is_mounted(path: &Path) -> bool {
        c_string(&path.to_string_lossy()).is_ok_and(|path| unsafe { nimbus_smb_mounted_at(path.as_ptr()) } == 1)
    }

    /// The share already mounted by Finder (or anyone), if it is.
    pub(super) fn existing_mount(endpoint: &str) -> Option<PathBuf> {
        let (host, share) = host_and_share(endpoint)?;
        let (host, share) = (c_string(&host).ok()?, c_string(&share).ok()?);
        let mut buffer = vec![0 as c_char; 1024];
        let found = unsafe { nimbus_smb_find_mount(host.as_ptr(), share.as_ptr(), buffer.as_mut_ptr(), buffer.len()) };
        (found == 1).then(|| PathBuf::from(unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().into_owned()))
    }

    /// Mount `endpoint` at `mountpath`; a missing user signs in as guest.
    pub(super) async fn mount(endpoint: &str, mountpath: &Path, user: &str, password: &str) -> Result<()> {
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
}

#[cfg(windows)]
mod mount {
    use std::{collections::HashMap, iter::once, ptr::null};

    use parking_lot::Mutex;
    use windows_sys::Win32::NetworkManagement::WNet::{
        WNetAddConnection2W, WNetCancelConnection2W, CONNECT_TEMPORARY, NETRESOURCEW, RESOURCETYPE_DISK,
    };

    use super::*;
    use crate::commands::accounts::account_token;

    /// Shares Cove has signed in to in this session, by account, with their network path.
    static CONNECTED: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

    /// "\\nas\影视": Windows reaches a share by its network path; nothing is mounted in a folder.
    fn unc(endpoint: &str) -> Result<PathBuf> {
        let url = url::Url::parse(endpoint)?;
        if url.port().is_some_and(|port| port != 445) {
            return Err(invalid("Windows 只能连接使用默认端口（445）的共享"));
        }
        let (host, share) = host_and_share(endpoint).ok_or_else(|| invalid("服务器地址无效，例如 smb://nas.local/影视"))?;
        Ok(PathBuf::from(format!(r"\\{host}\{share}")))
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(once(0)).collect()
    }

    /// Whether the share opens with what Windows already has: a saved sign-in, or guest access.
    async fn reachable(root: &Path) -> bool {
        let root = root.to_path_buf();
        let check = tokio::task::spawn_blocking(move || std::fs::read_dir(root).is_ok());
        matches!(tokio::time::timeout(MOUNT_TIMEOUT, check).await, Ok(Ok(true)))
    }

    /// What a Windows network error means for the person connecting.
    pub fn describe_error(code: u32) -> String {
        match code {
            1326 | 86 => "用户名或密码不正确".into(),
            5 => "没有访问这个共享的权限".into(),
            67 => "找不到这个共享，请检查共享名称".into(),
            53 | 64 | 1203 | 1222 | 1231 => "无法连接服务器，请确认它已开机并与这台电脑在同一网络中".into(),
            1219 => "这台电脑已用另一个账号连接了这台服务器，Windows 不允许同时使用两个账号。请先在资源管理器中断开，或使用同一账号".into(),
            1244 => "这台服务器需要用户名和密码".into(),
            _ => format!("无法连接共享（错误 {code}）"),
        }
    }

    async fn sign_in(root: &Path, user: &str, password: &str) -> Result<()> {
        let remote = wide(&root.to_string_lossy());
        let user = (!user.is_empty()).then(|| wide(user));
        let secret = zeroize::Zeroizing::new(password.encode_utf16().chain(once(0)).collect::<Vec<u16>>());
        let attempt = tokio::task::spawn_blocking(move || unsafe {
            let mut resource: NETRESOURCEW = std::mem::zeroed();
            resource.dwType = RESOURCETYPE_DISK;
            resource.lpRemoteName = remote.as_ptr() as *mut u16;
            // Without a user name, Windows tries the signed-in account and then guest access.
            let (password, user) = match &user {
                Some(user) => (secret.as_ptr(), user.as_ptr()),
                None => (null(), null()),
            };
            WNetAddConnection2W(&resource, password, user, CONNECT_TEMPORARY)
        });
        let code = tokio::time::timeout(MOUNT_TIMEOUT, attempt)
            .await
            .map_err(|_| invalid("连接共享超时，请确认服务器已开机并与这台电脑在同一网络中"))?
            .map_err(|error| NimbusError::Internal(error.to_string()))?;
        // Signed in already with other details: fine as long as the share opens.
        if code == 0 || (code == 1219 && reachable(root).await) {
            return Ok(());
        }
        Err(NimbusError::Validation(describe_error(code)))
    }

    fn sign_out(root: &Path) {
        let name = wide(&root.to_string_lossy());
        unsafe { WNetCancelConnection2W(name.as_ptr(), 0, 0) };
    }

    /// Check new connection details by signing in with them; used when adding or reconnecting a share.
    pub async fn connect(account_id: &str, endpoint: &str, user: &str, password: &str) -> Result<()> {
        let _guard = MOUNTING.lock().await;
        let root = unc(endpoint)?;
        // A connection made with older details would keep answering for the share.
        sign_out(&root);
        sign_in(&root, user, password).await?;
        if !reachable(&root).await {
            return Err(invalid("已连接服务器，但无法读取这个共享"));
        }
        CONNECTED.lock().get_or_insert_with(HashMap::new).insert(account_id.to_owned(), root);
        Ok(())
    }

    /// The share's network path, signing in first when needed.
    pub async fn ensure_mounted(state: &AppState, account_id: &str) -> Result<PathBuf> {
        if let Some(root) = CONNECTED.lock().as_ref().and_then(|connected| connected.get(account_id).cloned()) {
            return Ok(root);
        }
        let _guard = MOUNTING.lock().await;
        let (stored, password) = account_token(account_id, state).await?;
        let root = unc(&stored.account.endpoint)?;
        if !reachable(&root).await {
            sign_in(&root, stored.account.username.as_deref().unwrap_or_default(), &password).await?;
        }
        CONNECTED.lock().get_or_insert_with(HashMap::new).insert(account_id.to_owned(), root.clone());
        Ok(root)
    }

    /// Sign out of a removed share that Cove signed in to.
    pub fn forget(account_id: &str) {
        if let Some(root) = CONNECTED.lock().as_mut().and_then(|connected| connected.remove(account_id)) {
            sign_out(&root);
        }
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

/// A path in the mounted folder, as the library spells it (paths.rs) → the same path inside the
/// share ("/Movies/a.mkv").
pub fn to_share(root: &Path, local: &str) -> Option<String> {
    let root = crate::paths::portable(root);
    let rest = local.strip_prefix(root.trim_end_matches('/'))?;
    if rest.is_empty() {
        return Some("/".into());
    }
    rest.starts_with('/').then(|| rest.replace("//", "/"))
}

/// One folder of the share, with paths inside the share.
pub async fn browse(state: &AppState, account_id: &str, path: &str) -> Result<Vec<CloudEntry>> {
    let root = ensure_mounted(state, account_id).await?;
    let local = to_local(&root, path)?;
    let entries = tokio::task::spawn_blocking(move || local_storage::browse(&crate::paths::portable(&local)))
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
        local_storage::scan_root(&account_id, &crate::paths::portable(&local), &kind, 20_000)
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
        // Local paths arrive spelled as the library spells them (paths.rs).
        let portable = |path: &Path| crate::paths::portable(path);
        assert_eq!(to_share(root, &portable(&root.join("Movies/a.mkv"))).as_deref(), Some("/Movies/a.mkv"));
        assert_eq!(to_share(root, &portable(root)).as_deref(), Some("/"));
        assert_eq!(to_share(root, &format!("{}-other/a.mkv", portable(root))), None);
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

#[cfg(all(test, target_os = "macos"))]
mod native_tests {
    use super::mount::*;
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
