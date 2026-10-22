//! Browser sign-in for Google Drive and OneDrive: OAuth 2.0 with PKCE and a loopback redirect, as
//! desktop apps are meant to do it, plus keeping the access token fresh with the refresh token.
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::process::Command;
use uuid::Uuid;

use crate::{
    config::{oauth_client, OAuthClient},
    error::{NimbusError, Result},
};

/// Where a provider signs people in.
pub struct Endpoints {
    pub name: &'static str,
    authorize: &'static str,
    token: &'static str,
    scope: &'static str,
    /// Google takes a numeric loopback address; Microsoft registers "localhost".
    host: &'static str,
    extra: &'static [(&'static str, &'static str)],
}

pub fn endpoints(provider: &str) -> Option<Endpoints> {
    match provider {
        "google_drive" => Some(Endpoints {
            name: "Google Drive",
            authorize: "https://accounts.google.com/o/oauth2/v2/auth",
            token: "https://oauth2.googleapis.com/token",
            scope: "https://www.googleapis.com/auth/drive.readonly",
            host: "127.0.0.1",
            // A refresh token is issued only with offline access, and again only with consent.
            extra: &[("access_type", "offline"), ("prompt", "consent")],
        }),
        "onedrive" => Some(Endpoints {
            name: "OneDrive",
            authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scope: "offline_access Files.Read.All User.Read",
            host: "localhost",
            extra: &[("response_mode", "query"), ("prompt", "select_account")],
        }),
        _ => None,
    }
}

/// Saved in the Keychain for a signed-in Google Drive or OneDrive account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OAuthCredential {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds.
    pub expires_at: u64,
}

/// Whether browser sign-in is set up for `provider` (an app is registered for it).
pub fn is_available(provider: &str) -> bool {
    endpoints(provider).is_some() && oauth_client(provider).is_some()
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

/// A PKCE verifier and its S256 challenge.
pub fn pkce() -> (String, String) {
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    (verifier.clone(), challenge(&verifier))
}

fn challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()))
}

pub fn authorization_url(endpoints: &Endpoints, client: &OAuthClient, redirect: &str, state: &str, challenge: &str) -> Result<url::Url> {
    let mut url = url::Url::parse(endpoints.authorize)?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", &client.client_id)
            .append_pair("redirect_uri", redirect)
            .append_pair("response_type", "code")
            .append_pair("scope", endpoints.scope)
            .append_pair("state", state)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256");
        for (key, value) in endpoints.extra {
            query.append_pair(key, value);
        }
    }
    Ok(url)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Read a token reply; a refresh may leave out the refresh token, which then stays the same.
fn credential_from(body: &str, previous_refresh: Option<&str>, at: u64) -> Result<OAuthCredential> {
    let reply: TokenResponse = serde_json::from_str(body).map_err(|_| NimbusError::Validation("登录服务返回了无法识别的结果".into()))?;
    if let Some(error) = reply.error_description.or(reply.error) {
        return Err(NimbusError::Validation(format!("登录失败：{error}")));
    }
    let access_token = reply.access_token.ok_or_else(|| NimbusError::Validation("登录服务没有返回访问令牌".into()))?;
    let refresh_token = reply
        .refresh_token
        .or_else(|| previous_refresh.map(str::to_owned))
        .ok_or_else(|| NimbusError::Validation("登录服务没有返回刷新令牌，请重新登录".into()))?;
    // Renew a minute early so a request never starts with a token about to lapse.
    let expires_at = at + reply.expires_in.unwrap_or(3600).saturating_sub(60);
    Ok(OAuthCredential { access_token, refresh_token, expires_at })
}

async fn post_token(endpoints: &Endpoints, form: &[(&str, &str)]) -> Result<String> {
    let response = crate::http_client::http().post(endpoints.token).form(form).send().await?;
    Ok(response.text().await?)
}

/// Sign in through the browser and return the new tokens. Stops after three minutes, or when
/// `cancelled` fires (取消, or a newer sign-in).
pub async fn sign_in(provider: &str, cancelled: tokio::sync::oneshot::Receiver<()>) -> Result<OAuthCredential> {
    let endpoints = endpoints(provider).ok_or_else(|| NimbusError::Validation("这个位置不支持浏览器登录".into()))?;
    let client = oauth_client(provider).ok_or_else(|| {
        NimbusError::Validation(format!("还没有为 {} 配置登录应用（Client ID），请先在 .env 中填写", endpoints.name))
    })?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let redirect = format!("http://{}:{port}", endpoints.host);
    let state = Uuid::new_v4().simple().to_string();
    let (verifier, challenge) = pkce();
    let url = authorization_url(&endpoints, &client, &redirect, &state, &challenge)?;
    Command::new("open").arg(url.as_str()).spawn()?;

    let wait = tokio::time::timeout(
        Duration::from_secs(180),
        crate::commands::accounts::oauth_callback(&listener, port, &state, endpoints.name),
    );
    let parameters = tokio::select! {
        parameters = wait => parameters
            .map_err(|_| NimbusError::Validation(format!("3 分钟内没有收到 {} 的授权，已停止等待。请重新登录。", endpoints.name)))??,
        _ = cancelled => return Err(NimbusError::Validation(format!("已取消 {} 登录", endpoints.name))),
    };
    if let Some(error) = parameters.get("error_description").or_else(|| parameters.get("error")) {
        return Err(NimbusError::Validation(format!("{} 拒绝授权：{error}", endpoints.name)));
    }
    if parameters.get("state") != Some(&state) {
        return Err(NimbusError::Validation("授权安全校验失败".into()));
    }
    let code = parameters.get("code").ok_or_else(|| NimbusError::Validation("授权没有返回授权码".into()))?;
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("code_verifier", verifier.as_str()),
    ];
    if let Some(secret) = client.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let body = post_token(&endpoints, &form).await?;
    credential_from(&body, None, now())
}

/// A fresh access token for a saved credential, and the credential to save when it changed.
pub async fn access_token(provider: &str, credential: &OAuthCredential) -> Result<(String, Option<OAuthCredential>)> {
    if credential.expires_at > now() {
        return Ok((credential.access_token.clone(), None));
    }
    let endpoints = endpoints(provider).ok_or_else(|| NimbusError::Validation("这个位置不支持浏览器登录".into()))?;
    let client = oauth_client(provider).ok_or_else(|| NimbusError::Validation(format!("{} 的登录应用配置已不可用，请重新构建应用", endpoints.name)))?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", credential.refresh_token.as_str()),
        ("client_id", client.client_id.as_str()),
    ];
    if let Some(secret) = client.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    if provider == "onedrive" {
        form.push(("scope", endpoints.scope));
    }
    let body = post_token(&endpoints, &form).await?;
    let refreshed = credential_from(&body, Some(&credential.refresh_token), now())
        .map_err(|error| NimbusError::Validation(format!("{} 登录已过期，请重新连接：{error}", endpoints.name)))?;
    Ok((refreshed.access_token.clone(), Some(refreshed)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_the_s256_of_the_verifier() {
        // Checked independently: `printf <verifier> | openssl dgst -sha256 -binary | base64`, URL-safe, unpadded.
        assert_eq!(challenge("dBjftJeZ4CVP-mtG4MlOp9-n8mCYxjqUUPrDGeRaj1-k"), "TCuGtLW1CU_YI5BPKRzDm37P3v4Azi7cmzMbJQ0EXPU");
        let (verifier, derived) = pkce();
        assert_eq!(verifier.len(), 64);
        assert_eq!(derived, challenge(&verifier));
    }

    #[test]
    fn the_sign_in_page_asks_for_read_access_with_pkce() {
        let client = OAuthClient { client_id: "id".into(), client_secret: None };
        let url = authorization_url(&endpoints("onedrive").unwrap(), &client, "http://localhost:51234", "s", "c").unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["redirect_uri"], "http://localhost:51234");
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["scope"], "offline_access Files.Read.All User.Read");
        let google = authorization_url(&endpoints("google_drive").unwrap(), &client, "http://127.0.0.1:1", "s", "c").unwrap();
        assert!(google.as_str().contains("access_type=offline"));
    }

    #[test]
    fn token_replies_keep_the_refresh_token_and_renew_early() {
        let first = credential_from(r#"{"access_token":"a","refresh_token":"r","expires_in":3600}"#, None, 1000).unwrap();
        assert_eq!(first, OAuthCredential { access_token: "a".into(), refresh_token: "r".into(), expires_at: 1000 + 3540 });
        let refreshed = credential_from(r#"{"access_token":"b","expires_in":3600}"#, Some("r"), 5000).unwrap();
        assert_eq!(refreshed.refresh_token, "r");
        assert!(credential_from(r#"{"error":"invalid_grant","error_description":"expired"}"#, Some("r"), 0).unwrap_err().to_string().contains("expired"));
        assert!(credential_from(r#"{"access_token":"a"}"#, None, 0).is_err());
    }
}
