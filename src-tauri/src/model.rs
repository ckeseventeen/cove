use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub platform: String,
    pub database_ready: bool,
    pub account_count: usize,
    pub baidu_configured: bool,
    pub tmdb_configured: bool,
    pub mpv_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub endpoint: String,
    pub username: Option<String>,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    #[serde(default = "default_provider")]
    pub provider: String,
    pub label: String,
    pub endpoint: String,
    pub username: String,
    pub password: String,
}

fn default_provider() -> String {
    "webdav".into()
}

#[derive(Debug, Clone)]
pub struct StoredAccount {
    pub account: Account,
    pub secret_ref: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub id: String,
    pub account_id: String,
    pub remote_path: String,
    pub cloud_path: Option<String>,
    pub display_name: String,
    pub size: u64,
    pub etag: Option<String>,
    pub mime_type: Option<String>,
    pub source_id: Option<String>,
    pub source_ids: Vec<String>,
    pub media_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudEntry {
    pub id: String,
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSource {
    pub id: String,
    pub account_id: String,
    pub kind: String,
    pub remote_root: String,
    pub label: String,
    pub last_scan_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub visited_directories: usize,
    pub discovered_files: usize,
    pub media_files: usize,
    pub truncated: bool,
}
