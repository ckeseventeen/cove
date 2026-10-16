use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NimbusError {
    #[error("系统 IO 错误：{0}")]
    Io(#[from] std::io::Error),
    #[error("数据库错误：{0}")]
    Database(#[from] rusqlite::Error),
    #[error("网络请求失败：{0}")]
    Network(reqwest::Error),
    #[error("钥匙串错误：{0}")]
    Keyring(#[from] keyring::Error),
    #[error("地址无效：{0}")]
    Url(#[from] url::ParseError),
    #[error("JSON 处理失败：{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Validation(String),
    #[error("内部错误：{0}")]
    Internal(String),
}

/// Request URLs can carry secrets (Baidu sends `access_token`, and its OAuth calls the client
/// secret and refresh token, as query parameters), and these messages reach logs and the UI.
impl From<reqwest::Error> for NimbusError {
    fn from(error: reqwest::Error) -> Self {
        Self::Network(error.without_url())
    }
}

impl Serialize for NimbusError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, NimbusError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn network_errors_never_repeat_the_request_url() {
        // Nothing listens on port 1, so this fails fast and offline, carrying its URL.
        let failure = reqwest::Client::new()
            .get("http://127.0.0.1:1/rest/2.0/xpan/file?access_token=secret-token")
            .send()
            .await
            .unwrap_err();
        assert!(failure.to_string().contains("secret-token"));
        let message = NimbusError::from(failure).to_string();
        assert!(message.starts_with("网络请求失败"));
        assert!(!message.contains("secret-token"), "{message}");
    }
}
