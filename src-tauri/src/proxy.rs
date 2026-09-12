use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use serde::Deserialize;
use tokio::sync::RwLock;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{direct, error::Result, store::Store};

const SESSION_LIFETIME: Duration = Duration::from_secs(2 * 60 * 60);
pub type CredentialCache = Arc<RwLock<HashMap<String, Zeroizing<String>>>>;

#[derive(Clone)]
struct StreamSession {
    file_id: String,
    expires_at: Instant,
    cached_url: Option<(String, Instant)>,
}

#[derive(Clone)]
struct ProxyContext {
    store: Arc<Store>,
    sessions: Arc<RwLock<HashMap<String, StreamSession>>>,
    http: reqwest::Client,
    direct_http: reqwest::Client,
    credentials: CredentialCache,
}

pub struct StreamProxy {
    port: u16,
    sessions: Arc<RwLock<HashMap<String, StreamSession>>>,
}

impl StreamProxy {
    pub fn start(store: Arc<Store>, credentials: CredentialCache) -> Result<Self> {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let sessions = Arc::new(RwLock::new(HashMap::new()));
        let context = ProxyContext {
            store,
            sessions: Arc::clone(&sessions),
            http: reqwest::Client::builder()
                .user_agent("Nimbus/0.1")
                .connect_timeout(Duration::from_secs(12))
                .build()?,
            direct_http: reqwest::Client::builder()
                .no_proxy()
                .user_agent("Nimbus/0.1")
                .connect_timeout(Duration::from_secs(12))
                .build()?,
            credentials,
        };
        let router = Router::new()
            .route("/stream/{file_id}", get(stream))
            .with_state(context);
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("Nimbus could not start stream proxy: {error}");
                    return;
                }
            };
            if let Err(error) = axum::serve(listener, router).await {
                eprintln!("Nimbus stream proxy stopped: {error}");
            }
        });
        Ok(Self { port, sessions })
    }

    pub async fn renew(&self, file_id: &str) {
        let mut sessions = self.sessions.write().await;
        for session in sessions.values_mut().filter(|s| s.file_id == file_id) {
            session.expires_at = Instant::now() + SESSION_LIFETIME;
        }
        sessions.retain(|_, session| session.expires_at > Instant::now());
    }
    pub async fn revoke_all(&self) {
        self.sessions.write().await.clear();
    }

    pub async fn create_url(&self, file_id: String) -> String {
        let token = Uuid::new_v4().simple().to_string();
        let mut sessions = self.sessions.write().await;
        sessions.retain(|_, session| session.expires_at > Instant::now());
        sessions.insert(
            token.clone(),
            StreamSession {
                file_id: file_id.clone(),
                expires_at: Instant::now() + SESSION_LIFETIME,
                cached_url: None,
            },
        );
        format!(
            "http://127.0.0.1:{}/stream/{}?token={}",
            self.port, file_id, token
        )
    }
}

#[derive(Deserialize)]
struct StreamQuery {
    token: String,
}

fn error_response(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(message.to_owned()))
        .expect("valid error response")
}

fn media_content_type(name: &str) -> Option<&'static str> {
    let extension = name.rsplit_once('.')?.1.to_ascii_lowercase();
    match extension.as_str() {
        "mp4" => Some("video/mp4"),
        "m4v" => Some("video/x-m4v"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "mkv" => Some("video/x-matroska"),
        "ts" => Some("video/mp2t"),
        "m2ts" => Some("video/mp2t"),
        "avi" => Some("video/x-msvideo"),
        "flv" => Some("video/x-flv"),
        "wmv" => Some("video/x-ms-wmv"),
        "mp3" => Some("audio/mpeg"),
        "m4a" | "aac" => Some("audio/mp4"),
        "flac" => Some("audio/flac"),
        "wav" => Some("audio/wav"),
        "ogg" | "opus" => Some("audio/ogg"),
        _ => None,
    }
}

async fn stream(
    State(context): State<ProxyContext>,
    Path(file_id): Path<String>,
    Query(query): Query<StreamQuery>,
    request_headers: HeaderMap,
) -> Response<Body> {
    let session = {
        let mut sessions = context.sessions.write().await;
        let value = sessions.get_mut(&query.token);
        if let Some(session) = value {
            if session.expires_at > Instant::now() {
                session.expires_at = Instant::now() + SESSION_LIFETIME;
            }
            Some(session.clone())
        } else {
            None
        }
    };
    let Some(session) = session else {
        return error_response(StatusCode::UNAUTHORIZED, "无效的播放会话");
    };
    if session.file_id != file_id || session.expires_at <= Instant::now() {
        return error_response(StatusCode::UNAUTHORIZED, "播放会话已过期");
    }

    let file = match context.store.get_media_file(&file_id) {
        Ok(file) => file,
        Err(error) => return error_response(StatusCode::NOT_FOUND, &error.to_string()),
    };
    let (account, access_token) =
        match crate::credentials::get(&context.store, &context.credentials, &file.account_id).await
        {
            Ok(value) => value,
            Err(error) => return error_response(StatusCode::BAD_GATEWAY, &error.to_string()),
        };
    let mut remote_url = file.remote_path.clone();
    if account.account.provider == "baidu" {
        let mut from_cache = false;
        if let Some((url, time)) = session.cached_url.clone() {
            if time.elapsed() < Duration::from_secs(240) {
                remote_url = url;
                from_cache = true;
            }
        }

        let mut resolved_url = None;
        if !from_cache {
            if let Some(fs_id) = remote_url.strip_prefix("baidu://") {
                let fs_id = match fs_id.parse::<u64>() {
                    Ok(value) => value,
                    Err(error) => {
                        return error_response(StatusCode::BAD_GATEWAY, &error.to_string())
                    }
                };
                let resolve_started = Instant::now();
                remote_url = match direct::baidu_download_url(&access_token, fs_id).await {
                    Ok(url) => url,
                    Err(error) => {
                        return error_response(StatusCode::BAD_GATEWAY, &error.to_string())
                    }
                };
                eprintln!(
                    "Nimbus stream: Baidu link resolved in {:.2}s",
                    resolve_started.elapsed().as_secs_f64()
                );
                resolved_url = Some(remote_url.clone());
            } else if !remote_url.starts_with("http://") && !remote_url.starts_with("https://") {
                let parent_dir = std::path::Path::new(&remote_url)
                    .parent()
                    .and_then(|p| p.to_str())
                    .unwrap_or("/");
                let parent = if parent_dir.is_empty() {
                    "/"
                } else {
                    parent_dir
                };
                if let Ok(entries) = direct::browse("baidu", &access_token, parent).await {
                    if let Some(entry) = entries
                        .into_iter()
                        .find(|e| e.path == remote_url || e.name == file.display_name)
                    {
                        if let Ok(fs_id) = entry.id.parse::<u64>() {
                            if let Ok(url) = direct::baidu_download_url(&access_token, fs_id).await
                            {
                                remote_url = url;
                                resolved_url = Some(remote_url.clone());
                            }
                        }
                    }
                }
            }
        }

        match url::Url::parse(&remote_url) {
            Ok(mut parsed) => {
                parsed
                    .query_pairs_mut()
                    .append_pair("access_token", &access_token);
                remote_url = parsed.into();

                if resolved_url.is_some() {
                    let mut sessions = context.sessions.write().await;
                    if let Some(s) = sessions.get_mut(&query.token) {
                        s.cached_url = Some((remote_url.clone(), Instant::now()));
                    }
                }
            }
            Err(error) => return error_response(StatusCode::BAD_GATEWAY, &error.to_string()),
        }
    }
    let mut upstream = context.http.get(&remote_url);
    upstream = if account.account.provider == "webdav" {
        upstream.basic_auth(
            account.account.username.as_deref().unwrap_or_default(),
            Some(access_token.as_str()),
        )
    } else if account.account.provider == "baidu" {
        upstream.header(header::USER_AGENT, "pan.baidu.com")
    } else {
        upstream.bearer_auth(access_token)
    };
    if let Some(range) = request_headers.get(header::RANGE) {
        upstream = upstream.header(header::RANGE, range);
    } else if account.account.provider == "baidu" {
        // Baidu's CDN can leave a full-file request waiting without response headers.
        // mpv/FFmpeg begins with such a probe, so explicitly request a streamable range.
        upstream = upstream.header(header::RANGE, "bytes=0-8388607");
    }
    if let Some(if_range) = request_headers.get(header::IF_RANGE) {
        upstream = upstream.header(header::IF_RANGE, if_range);
    }

    let upstream_started = Instant::now();
    let upstream = match upstream.send().await {
        Ok(response) => response,
        Err(error) => {
            if account.account.provider == "baidu" {
                eprintln!(
                    "Nimbus stream upstream via proxy failed ({error}), retrying directly..."
                );
                let mut direct_request = context
                    .direct_http
                    .get(&remote_url)
                    .header(header::USER_AGENT, "pan.baidu.com");
                if let Some(range) = request_headers.get(header::RANGE) {
                    direct_request = direct_request.header(header::RANGE, range);
                } else {
                    direct_request = direct_request.header(header::RANGE, "bytes=0-8388607");
                }
                if let Some(if_range) = request_headers.get(header::IF_RANGE) {
                    direct_request = direct_request.header(header::IF_RANGE, if_range);
                }
                match direct_request.send().await {
                    Ok(response) => response,
                    Err(e) => {
                        return error_response(
                            StatusCode::BAD_GATEWAY,
                            &format!("{error} (直连重试失败: {e})"),
                        )
                    }
                }
            } else {
                return error_response(StatusCode::BAD_GATEWAY, &error.to_string());
            }
        }
    };
    eprintln!(
        "Nimbus stream: upstream headers received in {:.2}s",
        upstream_started.elapsed().as_secs_f64()
    );
    let status = upstream.status();
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        let mut response = Response::builder().status(status);
        if let Some(range) = upstream.headers().get(header::CONTENT_RANGE) {
            response = response.header(header::CONTENT_RANGE, range);
        } else if let Some(len) = upstream.headers().get(header::CONTENT_LENGTH) {
            if let Ok(len_str) = len.to_str() {
                response = response.header(header::CONTENT_RANGE, format!("bytes */{}", len_str));
            }
        }
        return response
            .body(Body::empty())
            .unwrap_or_else(|_| error_response(status, "Range 不满足"));
    }
    if !status.is_success() {
        eprintln!(
            "Nimbus stream upstream failed: provider={} status={} file={}",
            account.account.provider, status, file.display_name
        );
        return error_response(
            StatusCode::BAD_GATEWAY,
            &format!("云盘播放请求失败：上游 HTTP {status}"),
        );
    }
    let upstream_headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    for name in [
        header::ACCEPT_RANGES,
        header::CONTENT_RANGE,
        header::CONTENT_LENGTH,
        header::ETAG,
        header::LAST_MODIFIED,
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            response = response.header(name, value);
        }
    }
    if let Some(content_type) = media_content_type(&file.display_name).or_else(|| {
        upstream_headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
    }) {
        response = response.header(header::CONTENT_TYPE, content_type);
    }
    response
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|error| {
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("无法建立播放响应：{error}"),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_response_has_expected_status() {
        assert_eq!(
            error_response(StatusCode::RANGE_NOT_SATISFIABLE, "range").status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
    }
}
