use super::super::*;

pub(crate) fn save_account(
    store: &Store,
    provider: &str,
    label: &str,
    credential: &str,
) -> Result<Account> {
    let id = Uuid::new_v4().to_string();
    let secret_ref = format!("account:{id}");
    Entry::new("app.nimbus.desktop", &secret_ref)?.set_password(credential)?;
    let account = Account {
        id,
        provider: provider.into(),
        label: label.into(),
        endpoint: String::new(),
        username: None,
        status: "ok".into(),
    };
    if let Err(error) = store.insert_account(&account, &secret_ref) {
        let _ = Entry::new("app.nimbus.desktop", &secret_ref)
            .and_then(|entry| entry.delete_credential());
        return Err(error);
    }
    Ok(account)
}

#[tauri::command]
pub(crate) fn account_list(state: State<'_, AppState>) -> Result<Vec<Account>> {
    state.store.list_accounts()
}

#[tauri::command]
pub(crate) async fn account_remove(
    account_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    if state.store.get_account(&account_id)?.account.provider == "local" {
        return Err(NimbusError::Validation(
            "本地磁盘是系统存储源，不能删除".into(),
        ));
    }
    let stored = state.store.delete_account(&account_id)?;
    if stored.account.provider == "smb" {
        crate::smb::forget(&account_id);
    }
    crate::documents::remove_cached_copies(&app, &account_id).await;
    state.credentials.write().await.remove(&account_id);
    let secret_ref = stored.secret_ref;
    tauri::async_runtime::spawn_blocking(move || {
        let _ = Entry::new("app.nimbus.desktop", &secret_ref)
            .and_then(|entry| entry.delete_credential());
    });
    Ok(())
}

pub(crate) async fn account_token(
    account_id: &str,
    state: &AppState,
) -> Result<(model::StoredAccount, String)> {
    credentials::get(&state.store, &state.credentials, account_id).await
}

#[tauri::command]
pub(crate) async fn account_browse(
    account_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<CloudEntry>> {
    browse_directory(&state, &account_id, &path).await
}

/// One folder of any account, as the file browser shows it.
pub(crate) async fn browse_directory(state: &AppState, account_id: &str, path: &str) -> Result<Vec<CloudEntry>> {
    let stored = state.store.get_account(account_id)?;
    if stored.account.provider == "smb" {
        return crate::smb::browse(state, account_id, path).await;
    }
    if stored.account.provider == "local" {
        let path = path.to_owned();
        return tokio::task::spawn_blocking(move || local_storage::browse(&path))
            .await
            .map_err(|e| NimbusError::Internal(e.to_string()))?;
    }
    let (stored, token) = account_token(account_id, state).await?;
    if stored.account.provider == "webdav" {
        return webdav::browse(
            &stored.account.endpoint,
            path,
            stored.account.username.as_deref().unwrap_or_default(),
            &token,
        )
        .await;
    }
    direct::browse(&stored.account.provider, &token, path).await
}

#[tauri::command]
pub(crate) async fn account_scan(
    account_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ScanResult> {
    let sources = state
        .store
        .list_media_sources()?
        .into_iter()
        .filter(|s| s.account_id == account_id)
        .collect::<Vec<_>>();
    let mut total = ScanResult {
        visited_directories: 0,
        discovered_files: 0,
        media_files: 0,
        truncated: false,
        skipped_directories: Vec::new(),
    };
    for source in sources {
        let result = crate::auto_scan::scan(&app, &source.id, false).await?;
        total.visited_directories += result.visited_directories;
        total.discovered_files += result.discovered_files;
        total.media_files += result.media_files;
        total.truncated |= result.truncated;
        total.skipped_directories.extend(result.skipped_directories);
    }
    Ok(total)
}

/// The Baidu sign-in waiting for the browser; 取消 (or a newer sign-in) sends on it.
pub(crate) static BAIDU_SIGN_IN: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
    std::sync::Mutex::new(None);
/// Held while a sign-in has the callback port bound.
static BAIDU_CALLBACK_PORT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Stops a Baidu sign-in that is waiting for the browser. Returns once its callback port is
/// free again, so signing in right away works.
#[tauri::command]
pub(crate) async fn baidu_oauth_cancel() -> Result<()> {
    let pending = BAIDU_SIGN_IN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some(cancel) = pending {
        let _ = cancel.send(());
    }
    drop(BAIDU_CALLBACK_PORT.lock().await);
    Ok(())
}

/// Signs in to Baidu in the browser. With `account_id`, the new login replaces that account's
/// credential and keeps its id, so its folders, playback progress and playlists stay.
#[tauri::command]
pub(crate) async fn baidu_oauth_connect(
    label: String,
    account_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Account> {
    let existing = match account_id {
        Some(id) => {
            let stored = state.store.get_account(&id)?;
            if stored.account.provider != "baidu" {
                return Err(NimbusError::Validation("这个位置不是百度网盘".into()));
            }
            Some(stored)
        }
        None => None,
    };
    let label = label.trim();
    if existing.is_none() && label.is_empty() {
        return Err(NimbusError::Validation("显示名称不能为空".into()));
    }
    let config = config::BaiduConfig::load()?;
    let redirect = url::Url::parse(&config.redirect_uri)?;
    if redirect.scheme() != "http"
        || !matches!(redirect.host_str(), Some("127.0.0.1" | "localhost"))
    {
        return Err(NimbusError::Validation(
            "百度回调地址必须是本机 HTTP 地址".into(),
        ));
    }
    let port = redirect
        .port()
        .ok_or_else(|| NimbusError::Validation("百度回调地址缺少端口".into()))?;

    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let previous = BAIDU_SIGN_IN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .replace(cancel);
    if let Some(previous) = previous {
        let _ = previous.send(());
    }
    let credential = tokio::select! {
        credential = async {
            let code = baidu_authorization_code(&config, port).await?;
            let credential = direct::exchange_baidu_code(&code).await?;
            direct::validate("baidu", &credential.access_token).await?;
            Ok::<_, NimbusError>(credential)
        } => credential?,
        _ = cancelled => return Err(NimbusError::Validation("已取消百度网盘登录".into())),
    };
    let serialized = Zeroizing::new(serde_json::to_string(&credential)?);
    if let Some(stored) = existing {
        credentials::replace(&state.credentials, &stored, serialized).await?;
        return Ok(stored.account);
    }
    let account = save_account(&state.store, "baidu", label, &serialized)?;
    state
        .credentials
        .write()
        .await
        .insert(account.id.clone(), serialized);
    Ok(account)
}

/// Whether Google Drive or OneDrive can sign in through the browser (an OAuth app is configured).
#[tauri::command]
pub(crate) fn oauth_available(provider: String) -> bool {
    crate::oauth::is_available(&provider)
}

/// Sign in to Google Drive or OneDrive in the browser; with `account_id`, reconnect that account.
#[tauri::command]
pub(crate) async fn oauth_connect(
    provider: String,
    label: String,
    account_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Account> {
    if !matches!(provider.as_str(), "google_drive" | "onedrive") {
        return Err(NimbusError::Validation("这个位置不支持浏览器登录".into()));
    }
    let existing = match account_id {
        Some(id) => {
            let stored = state.store.get_account(&id)?;
            if stored.account.provider != provider {
                return Err(NimbusError::Validation("账号类型不一致".into()));
            }
            Some(stored)
        }
        None => None,
    };
    let label = label.trim();
    if existing.is_none() && label.is_empty() {
        return Err(NimbusError::Validation("显示名称不能为空".into()));
    }
    // One sign-in at a time; 取消 (baidu_oauth_cancel) stops this one too.
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let previous = BAIDU_SIGN_IN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .replace(cancel);
    if let Some(previous) = previous {
        let _ = previous.send(());
    }
    let credential = crate::oauth::sign_in(&provider, cancelled).await?;
    direct::validate(&provider, &credential.access_token).await?;
    let serialized = Zeroizing::new(serde_json::to_string(&credential)?);
    if let Some(stored) = existing {
        credentials::replace(&state.credentials, &stored, serialized).await?;
        return Ok(stored.account);
    }
    let account = save_account(&state.store, &provider, label, &serialized)?;
    state.credentials.write().await.insert(account.id.clone(), serialized);
    Ok(account)
}

/// Opens Baidu's authorization page and waits up to 3 minutes for the browser to come back
/// with a code.
async fn baidu_authorization_code(config: &config::BaiduConfig, port: u16) -> Result<String> {
    let _port = BAIDU_CALLBACK_PORT.lock().await;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| {
            NimbusError::Validation(format!("无法监听百度授权回调端口 {port}：{error}"))
        })?;
    let state_token = Uuid::new_v4().simple().to_string();
    let mut authorization = url::Url::parse("https://openapi.baidu.com/oauth/2.0/authorize")?;
    authorization
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config.app_key)
        .append_pair("redirect_uri", &config.redirect_uri)
        .append_pair("scope", "basic,netdisk")
        .append_pair("state", &state_token);
    Command::new("open").arg(authorization.as_str()).spawn()?;

    let parameters = tokio::time::timeout(
        Duration::from_secs(180),
        oauth_callback(&listener, port, &state_token, "百度网盘"),
    )
    .await
    .map_err(|_| {
        NimbusError::Validation(
            "3 分钟内没有收到百度网盘的授权，已停止等待。请重新登录。".into(),
        )
    })??;
    let oauth_error = parameters
        .get("error_description")
        .or_else(|| parameters.get("error"))
        .cloned();
    if let Some(error) = oauth_error {
        return Err(NimbusError::Validation(format!("百度拒绝授权：{error}")));
    }
    if parameters.get("state").map(String::as_str) != Some(state_token.as_str()) {
        return Err(NimbusError::Validation("百度授权安全校验失败".into()));
    }
    parameters
        .get("code")
        .cloned()
        .ok_or_else(|| NimbusError::Validation("百度授权未返回授权码".into()))
}

/// Answers requests on the callback port until one carries the sign-in reply. Anything else, such
/// as a favicon request or an idle preconnection, is turned away.
pub(crate) async fn oauth_callback(
    listener: &tokio::net::TcpListener,
    port: u16,
    state_token: &str,
    service: &str,
) -> Result<std::collections::HashMap<String, String>> {
    loop {
        let (mut socket, _) = listener.accept().await?;
        let mut request = vec![0u8; 8192];
        let Ok(Ok(size)) =
            tokio::time::timeout(Duration::from_secs(10), socket.read(&mut request)).await
        else {
            continue;
        };
        let first_line = String::from_utf8_lossy(&request[..size])
            .lines()
            .next()
            .unwrap_or_default()
            .to_owned();
        let parameters: std::collections::HashMap<_, _> = first_line
            .split_whitespace()
            .nth(1)
            .and_then(|target| url::Url::parse(&format!("http://127.0.0.1:{port}{target}")).ok())
            .map(|callback| callback.query_pairs().into_owned().collect())
            .unwrap_or_default();
        if !parameters.contains_key("code") && !parameters.contains_key("error") {
            let _ = socket
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            continue;
        }
        let success = parameters.contains_key("code")
            && parameters.get("state").map(String::as_str) == Some(state_token);
        let (status, body) = if success {
            ("200 OK", format!("<h2>{service}授权成功</h2><p>可以关闭这个页面并返回 Cove。</p>"))
        } else {
            ("400 Bad Request", format!("<h2>{service}授权失败</h2><p>请关闭页面并返回 Cove 重试。</p>"))
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await?;
        return Ok(parameters);
    }
}

/// Saves a new password or token for an existing WebDAV, Google Drive or OneDrive account
/// under the same id, so its folders, playback progress and playlists stay.
#[tauri::command]
pub(crate) async fn account_update_credentials(
    account_id: String,
    username: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<Account> {
    let stored = state.store.get_account(&account_id)?;
    let mut account = stored.account.clone();
    let password = Zeroizing::new(password);
    let secret = match account.provider.as_str() {
        "webdav" => {
            let username = username.trim();
            webdav::validate_connection(&account.endpoint, username, &password).await?;
            account.username = (!username.is_empty()).then(|| username.to_owned());
            password
        }
        "google_drive" | "onedrive" => {
            let token = Zeroizing::new(password.trim().to_owned());
            direct::validate(&account.provider, &token).await?;
            token
        }
        "smb" => {
            let username = username.trim();
            crate::smb::connect(&account.id, &account.endpoint, username, &password).await?;
            account.username = (!username.is_empty()).then(|| username.to_owned());
            password
        }
        "baidu" => {
            return Err(NimbusError::Validation(
                "百度网盘需要在浏览器中重新登录".into(),
            ))
        }
        _ => {
            return Err(NimbusError::Validation(
                "这个位置不需要重新连接".into(),
            ))
        }
    };
    credentials::replace(&state.credentials, &stored, secret).await?;
    if account.username != stored.account.username {
        state
            .store
            .update_account_username(&account.id, account.username.as_deref())?;
    }
    Ok(account)
}

#[tauri::command]
pub(crate) async fn account_add(
    input: AccountInput,
    state: State<'_, AppState>,
) -> Result<Account> {
    let label = input.label.trim();
    if label.is_empty() {
        return Err(NimbusError::Validation("显示名称不能为空".into()));
    }
    let password = Zeroizing::new(input.password);
    let id = Uuid::new_v4().to_string();
    // A share is checked by mounting it, as Finder would.
    let endpoint = if input.provider == "smb" {
        let endpoint = crate::smb::normalize_url(&input.endpoint)?;
        crate::smb::connect(&id, &endpoint, input.username.trim(), &password).await?;
        endpoint
    } else {
        input.endpoint.trim().trim_end_matches('/').to_string()
    };
    if input.provider == "webdav" {
        webdav::validate_connection(input.endpoint.trim(), input.username.trim(), &password)
            .await?;
    } else if input.provider != "smb" {
        direct::validate(&input.provider, &password).await?;
    }

    if input.provider == "webdav" || input.provider == "smb" {
        let secret_ref = format!("account:{id}");
        Entry::new("app.nimbus.desktop", &secret_ref)?.set_password(&password)?;
        let account = Account {
            id,
            provider: input.provider.clone(),
            label: label.into(),
            endpoint,
            username: (!input.username.trim().is_empty())
                .then(|| input.username.trim().to_string()),
            status: "ok".into(),
        };
        if let Err(error) = state.store.insert_account(&account, &secret_ref) {
            let _ = Entry::new("app.nimbus.desktop", &secret_ref)
                .and_then(|entry| entry.delete_credential());
            return Err(error);
        }
        state
            .credentials
            .write()
            .await
            .insert(account.id.clone(), password.clone());
        Ok(account)
    } else {
        let account = save_account(&state.store, &input.provider, label, &password)?;
        state
            .credentials
            .write()
            .await
            .insert(account.id.clone(), password.clone());
        Ok(account)
    }
}
