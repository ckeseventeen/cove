use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NimbusError {
    #[error("系统 IO 错误：{0}")]
    Io(#[from] std::io::Error),
    #[error("数据库错误：{0}")]
    Database(#[from] rusqlite::Error),
    #[error("网络请求失败：{0}")]
    Network(#[from] reqwest::Error),
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

impl Serialize for NimbusError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, NimbusError>;
