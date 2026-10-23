use std::{collections::HashMap, env, fs, path::PathBuf};

use crate::error::{NimbusError, Result};

include!(concat!(env!("OUT_DIR"), "/baidu_build_config.rs"));

#[derive(Clone)]
pub struct BaiduConfig {
    pub app_key: String,
    pub secret_key: String,
    pub redirect_uri: String,
}

#[derive(Clone)]
pub struct TmdbConfig {
    pub read_access_token: String,
}

fn dotenv_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(current) = env::current_dir() {
        paths.push(current.join(".env"));
        paths.push(current.join("..").join(".env"));
    }
    if let Ok(executable) = env::current_exe() {
        if let Some(directory) = executable.parent() {
            paths.push(directory.join(".env"));
            paths.push(directory.join("..").join("..").join("..").join(".env"));
        }
    }
    paths
}

fn local_values() -> HashMap<String, String> {
    let Some(contents) = dotenv_paths()
        .into_iter()
        .find_map(|path| fs::read_to_string(path).ok())
    else {
        return HashMap::new();
    };
    contents
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            Some((
                key.trim().to_owned(),
                value.trim().trim_matches(['\'', '"']).to_owned(),
            ))
        })
        .collect()
}

/// Where Baidu sends the browser back after sign-in when no other address is set; it must also be
/// the callback address registered for the app on Baidu's open platform.
pub const DEFAULT_BAIDU_REDIRECT_URI: &str = "http://127.0.0.1:53682/oauth/baidu/callback";

/// The settings that can be saved from 设置 › 服务, for builds without a .env.
pub const SAVABLE: [&str; 4] = [
    "NIMBUS_BAIDU_APP_KEY",
    "NIMBUS_BAIDU_SECRET_KEY",
    "NIMBUS_BAIDU_REDIRECT_URI",
    "NIMBUS_TMDB_READ_ACCESS_TOKEN",
];

/// The Keychain / Credential Manager entry that holds the saved settings, as one JSON object.
const SAVED_ENTRY: &str = "service-settings";

/// The saved settings, read from the secret store once.
static SAVED: std::sync::RwLock<Option<HashMap<String, String>>> = std::sync::RwLock::new(None);

fn saved_values() -> HashMap<String, String> {
    if let Some(values) = SAVED.read().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref() {
        return values.clone();
    }
    let values: HashMap<String, String> = crate::credentials::secret_get(crate::credentials::SERVICE, SAVED_ENTRY)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    *SAVED.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(values.clone());
    values
}

/// A setting as saved in the app (not from the environment, .env or a personal build).
pub fn saved(name: &str) -> Option<String> {
    saved_values().remove(name).filter(|value| !value.trim().is_empty())
}

/// Saves settings from 设置 › 服务: a value replaces the saved one, an empty value removes it.
pub fn save(changes: HashMap<String, String>) -> Result<()> {
    let mut values = saved_values();
    for (name, value) in changes {
        if !SAVABLE.contains(&name.as_str()) {
            return Err(NimbusError::Validation(format!("未知的设置 {name}")));
        }
        let value = value.trim();
        if value.is_empty() {
            values.remove(&name);
        } else {
            values.insert(name, value.to_owned());
        }
    }
    if values.is_empty() {
        crate::credentials::secret_delete(crate::credentials::SERVICE, SAVED_ENTRY);
    } else {
        let json = zeroize::Zeroizing::new(serde_json::to_string(&values)?);
        crate::credentials::secret_set(crate::credentials::SERVICE, SAVED_ENTRY, &json)?;
    }
    *SAVED.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(values);
    Ok(())
}

impl BaiduConfig {
    pub fn load() -> Result<Self> {
        let missing = || {
            NimbusError::Validation(
                "还没有填写百度网盘开放平台的 AppKey 和 SecretKey，请在“设置 › 服务”中填写".into(),
            )
        };
        Ok(Self {
            app_key: setting("NIMBUS_BAIDU_APP_KEY").ok_or_else(missing)?,
            secret_key: setting("NIMBUS_BAIDU_SECRET_KEY").ok_or_else(missing)?,
            redirect_uri: setting("NIMBUS_BAIDU_REDIRECT_URI")
                .unwrap_or_else(|| DEFAULT_BAIDU_REDIRECT_URI.to_owned()),
        })
    }
}

impl TmdbConfig {
    pub fn load() -> Result<Self> {
        Ok(Self {
            read_access_token: setting("NIMBUS_TMDB_READ_ACCESS_TOKEN").ok_or_else(|| {
                NimbusError::Validation(
                    "还没有填写 TMDB 的 API 读访问令牌，请在“设置 › 服务”中填写".into(),
                )
            })?,
        })
    }
}

/// One setting from the environment, the project's .env, 设置 › 服务, or a personal build; empty
/// counts as unset.
fn setting(name: &str) -> Option<String> {
    let bundled = match name {
        "NIMBUS_BAIDU_APP_KEY" => BUNDLED_BAIDU_APP_KEY,
        "NIMBUS_BAIDU_SECRET_KEY" => BUNDLED_BAIDU_SECRET_KEY,
        "NIMBUS_BAIDU_REDIRECT_URI" => BUNDLED_BAIDU_REDIRECT_URI,
        "NIMBUS_TMDB_READ_ACCESS_TOKEN" => BUNDLED_TMDB_READ_ACCESS_TOKEN,
        "NIMBUS_GOOGLE_CLIENT_ID" => BUNDLED_GOOGLE_CLIENT_ID,
        "NIMBUS_GOOGLE_CLIENT_SECRET" => BUNDLED_GOOGLE_CLIENT_SECRET,
        "NIMBUS_ONEDRIVE_CLIENT_ID" => BUNDLED_ONEDRIVE_CLIENT_ID,
        _ => "",
    };
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| local_values().get(name).cloned())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| saved(name))
        .or_else(|| (!bundled.trim().is_empty()).then(|| bundled.to_owned()))
}

/// The OAuth app registered for Google Drive or OneDrive sign-in. Google's desktop clients carry a
/// client secret that Google itself documents as not confidential; Microsoft's public clients have none.
#[derive(Clone)]
pub struct OAuthClient {
    pub client_id: String,
    pub client_secret: Option<String>,
}

pub fn oauth_client(provider: &str) -> Option<OAuthClient> {
    match provider {
        "google_drive" => Some(OAuthClient {
            client_id: setting("NIMBUS_GOOGLE_CLIENT_ID")?,
            client_secret: setting("NIMBUS_GOOGLE_CLIENT_SECRET"),
        }),
        "onedrive" => Some(OAuthClient { client_id: setting("NIMBUS_ONEDRIVE_CLIENT_ID")?, client_secret: None }),
        _ => None,
    }
}
