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

impl BaiduConfig {
    pub fn load() -> Result<Self> {
        let local = local_values();
        let bundled = |name: &str| match name {
            "NIMBUS_BAIDU_APP_KEY" => Some(BUNDLED_BAIDU_APP_KEY),
            "NIMBUS_BAIDU_SECRET_KEY" => Some(BUNDLED_BAIDU_SECRET_KEY),
            "NIMBUS_BAIDU_REDIRECT_URI" => Some(BUNDLED_BAIDU_REDIRECT_URI),
            _ => None,
        };
        let get = |name: &str| {
            env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    local
                        .get(name)
                        .cloned()
                        .filter(|value| !value.trim().is_empty())
                })
                .or_else(|| {
                    bundled(name)
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_owned)
                })
                .ok_or_else(|| {
                    NimbusError::Validation(format!("缺少 {name}，请重新构建个人版应用"))
                })
        };
        Ok(Self {
            app_key: get("NIMBUS_BAIDU_APP_KEY")?,
            secret_key: get("NIMBUS_BAIDU_SECRET_KEY")?,
            redirect_uri: get("NIMBUS_BAIDU_REDIRECT_URI")?,
        })
    }
}

impl TmdbConfig {
    pub fn load() -> Result<Self> {
        let local = local_values();
        let bundled = |name: &str| match name {
            "NIMBUS_TMDB_READ_ACCESS_TOKEN" => Some(BUNDLED_TMDB_READ_ACCESS_TOKEN),
            _ => None,
        };
        let get = |name: &str| {
            env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    local
                        .get(name)
                        .cloned()
                        .filter(|value| !value.trim().is_empty())
                })
                .or_else(|| {
                    bundled(name)
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_owned)
                })
                .ok_or_else(|| {
                    NimbusError::Validation(format!("缺少 {name}，请重新构建个人版应用"))
                })
        };
        Ok(Self {
            read_access_token: get("NIMBUS_TMDB_READ_ACCESS_TOKEN")?,
        })
    }
}
