use super::super::*;
use super::library::media_source_scan;

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
pub(crate) async fn account_remove(account_id: String, state: State<'_, AppState>) -> Result<()> {
    if state.store.get_account(&account_id)?.account.provider == "local" {
        return Err(NimbusError::Validation(
            "本地磁盘是系统存储源，不能删除".into(),
        ));
    }
    let stored = state.store.delete_account(&account_id)?;
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
    let stored = state.store.get_account(&account_id)?;
    if stored.account.provider == "local" {
        return tokio::task::spawn_blocking(move || local_storage::browse(&path))
            .await
            .map_err(|e| NimbusError::Internal(e.to_string()))?;
    }
    let (stored, token) = account_token(&account_id, &state).await?;
    if stored.account.provider == "webdav" {
        return webdav::browse(
            &stored.account.endpoint,
            &path,
            stored.account.username.as_deref().unwrap_or_default(),
            &token,
        )
        .await;
    }
    direct::browse(&stored.account.provider, &token, &path).await
}

#[tauri::command]
pub(crate) async fn account_scan(
    account_id: String,
    state: State<'_, AppState>,
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
    };
    for source in sources {
        let result = media_source_scan(source.id, state.clone()).await?;
        total.visited_directories += result.visited_directories;
        total.discovered_files += result.discovered_files;
        total.media_files += result.media_files;
        total.truncated |= result.truncated;
    }
    Ok(total)
}

#[tauri::command]
pub(crate) async fn baidu_oauth_connect(
    label: String,
    state: State<'_, AppState>,
) -> Result<Account> {
    let label = label.trim();
    if label.is_empty() {
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

    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(180), listener.accept())
        .await
        .map_err(|_| NimbusError::Validation("百度授权等待超时，请重新连接".into()))??;
    let mut request = vec![0u8; 8192];
    let size = socket.read(&mut request).await?;
    let first_line = String::from_utf8_lossy(&request[..size])
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned();
    let target = first_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| NimbusError::Validation("百度授权回调格式无效".into()))?;
    let callback = url::Url::parse(&format!("http://127.0.0.1:{port}{target}"))?;
    let parameters: std::collections::HashMap<_, _> = callback.query_pairs().into_owned().collect();
    let code = parameters.get("code").cloned();
    let returned_state = parameters.get("state").cloned();
    let oauth_error = parameters
        .get("error_description")
        .or_else(|| parameters.get("error"))
        .cloned();
    let success = code.is_some() && returned_state.as_deref() == Some(state_token.as_str());
    let (status, body) = if success {
        (
            "200 OK",
            "<h2>百度网盘授权成功</h2><p>可以关闭这个页面并返回 Nimbus。</p>",
        )
    } else {
        (
            "400 Bad Request",
            "<h2>百度网盘授权失败</h2><p>请关闭页面并返回 Nimbus 重试。</p>",
        )
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(response.as_bytes()).await?;
    if let Some(error) = oauth_error {
        return Err(NimbusError::Validation(format!("百度拒绝授权：{error}")));
    }
    if returned_state.as_deref() != Some(state_token.as_str()) {
        return Err(NimbusError::Validation("百度授权安全校验失败".into()));
    }
    let credential = direct::exchange_baidu_code(
        &code.ok_or_else(|| NimbusError::Validation("百度授权未返回授权码".into()))?,
    )
    .await?;
    direct::validate("baidu", &credential.access_token).await?;
    let serialized = serde_json::to_string(&credential)?;
    let account = save_account(&state.store, "baidu", label, &serialized)?;
    state
        .credentials
        .write()
        .await
        .insert(account.id.clone(), Zeroizing::new(serialized));
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
    if input.provider == "webdav" {
        webdav::validate_connection(input.endpoint.trim(), input.username.trim(), &password)
            .await?;
    } else {
        direct::validate(&input.provider, &password).await?;
    }

    if input.provider == "webdav" {
        let id = Uuid::new_v4().to_string();
        let secret_ref = format!("account:{id}");
        Entry::new("app.nimbus.desktop", &secret_ref)?.set_password(&password)?;
        let account = Account {
            id,
            provider: input.provider.clone(),
            label: label.into(),
            endpoint: input.endpoint.trim().trim_end_matches('/').to_string(),
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
