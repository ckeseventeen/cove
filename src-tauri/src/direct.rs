use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::{
    config::BaiduConfig,
    error::{NimbusError, Result},
    model::{CloudEntry, MediaFile, ScanResult},
};

const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "m4v", "mov", "avi", "webm", "ts", "m2ts", "flv", "wmv",
];
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "ape"];

fn is_media(name: &str, kind: &str) -> bool {
    let Some((_, extension)) = name.rsplit_once('.') else {
        return false;
    };
    let extension = extension.to_ascii_lowercase();
    if kind == "document" {
        crate::media_types::DOCUMENT_EXTENSIONS.contains(&extension.as_str())
    } else if kind == "music" {
        AUDIO_EXTENSIONS.contains(&extension.as_str())
    } else {
        VIDEO_EXTENSIONS.contains(&extension.as_str())
    }
}

fn http() -> Result<Client> {
    static CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = Client::builder()
        .user_agent("Nimbus/0.2")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()?;
    let _ = CLIENT.set(client.clone());
    Ok(client)
}

fn direct_http() -> Result<Client> {
    static CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = Client::builder()
        .no_proxy()
        .user_agent("Nimbus/0.2")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()?;
    let _ = CLIENT.set(client.clone());
    Ok(client)
}

fn transfer_http() -> Result<Client> {
    static CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = Client::builder()
        .user_agent("pan.baidu.com")
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()?;
    let _ = CLIENT.set(client.clone());
    Ok(client)
}

fn direct_transfer_http() -> Result<Client> {
    static CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = Client::builder()
        .no_proxy()
        .user_agent("pan.baidu.com")
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()?;
    let _ = CLIENT.set(client.clone());
    Ok(client)
}
struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BaiduCredential {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
}

#[derive(Deserialize)]
struct BaiduTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

impl BaiduTokenResponse {
    fn into_credential(self, fallback_refresh_token: Option<&str>) -> Result<BaiduCredential> {
        let access_token = self.access_token.ok_or_else(|| {
            NimbusError::Validation(format!(
                "百度授权失败：{}",
                self.error_description
                    .or(self.error)
                    .unwrap_or_else(|| "未返回 Access Token".into())
            ))
        })?;
        let refresh_token = self
            .refresh_token
            .or_else(|| fallback_refresh_token.map(str::to_owned))
            .ok_or_else(|| NimbusError::Validation("百度授权未返回 Refresh Token".into()))?;
        Ok(BaiduCredential {
            access_token,
            refresh_token,
            // Refresh a little early so playback does not cross the expiry boundary.
            expires_at: unix_now() + self.expires_in.unwrap_or(2_592_000).saturating_sub(300),
        })
    }
}

pub async fn exchange_baidu_code(code: &str) -> Result<BaiduCredential> {
    let config = BaiduConfig::load()?;
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", config.app_key.as_str()),
        ("client_secret", config.secret_key.as_str()),
        ("redirect_uri", config.redirect_uri.as_str()),
    ];
    let request_send = match http()?
        .post("https://openapi.baidu.com/oauth/2.0/token")
        .form(&form)
        .send()
        .await
    {
        Ok(res) => Ok(res),
        Err(err) => {
            eprintln!("Baidu token exchange via default client failed ({err}), retrying directly without proxy...");
            direct_http()?
                .post("https://openapi.baidu.com/oauth/2.0/token")
                .form(&form)
                .send()
                .await
        }
    };
    let response: BaiduTokenResponse = request_send?.json().await?;
    response.into_credential(None)
}

async fn refresh_baidu(credential: &BaiduCredential) -> Result<BaiduCredential> {
    let config = BaiduConfig::load()?;
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", credential.refresh_token.as_str()),
        ("client_id", config.app_key.as_str()),
        ("client_secret", config.secret_key.as_str()),
    ];
    let request_send = match http()?
        .post("https://openapi.baidu.com/oauth/2.0/token")
        .form(&form)
        .send()
        .await
    {
        Ok(res) => Ok(res),
        Err(err) => {
            eprintln!("Baidu token refresh via default client failed ({err}), retrying directly without proxy...");
            direct_http()?
                .post("https://openapi.baidu.com/oauth/2.0/token")
                .form(&form)
                .send()
                .await
        }
    };
    let response: BaiduTokenResponse = request_send?.json().await?;
    response.into_credential(Some(&credential.refresh_token))
}

/// Resolves the token used for API calls and returns an updated serialized credential when a
/// refresh was necessary. Existing raw-token accounts remain supported.
pub async fn access_token(provider: &str, stored: &str) -> Result<(String, Option<String>)> {
    if provider != "baidu" {
        return Ok((stored.to_owned(), None));
    }
    let Ok(credential) = serde_json::from_str::<BaiduCredential>(stored) else {
        return Ok((stored.to_owned(), None));
    };
    if credential.expires_at > unix_now() {
        return Ok((credential.access_token, None));
    }
    let refreshed = refresh_baidu(&credential).await?;
    let token = refreshed.access_token.clone();
    Ok((token, Some(serde_json::to_string(&refreshed)?)))
}

pub async fn validate(provider: &str, token: &str) -> Result<()> {
    let url = match provider {
        "google_drive" => "https://www.googleapis.com/drive/v3/files/root?fields=id,name",
        "onedrive" => "https://graph.microsoft.com/v1.0/me/drive/root?$select=id,name",
        "baidu" => "https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo",
        "alidrive" => {
            return Err(NimbusError::Validation(
                "阿里云盘直连需要先配置开放平台 Client ID".into(),
            ))
        }
        "quark" => {
            return Err(NimbusError::Validation(
                "夸克没有公开个人网盘文件 API，暂不支持非官方 Cookie 接入".into(),
            ))
        }
        _ => return Err(NimbusError::Validation("未知的网盘类型".into())),
    };
    let response = if provider == "baidu" {
        match http()?
            .get(url)
            .query(&[("access_token", token)])
            .send()
            .await
        {
            Ok(res) => res,
            Err(err) => {
                eprintln!("Baidu validate via default client failed ({err}), retrying directly without proxy...");
                direct_http()?
                    .get(url)
                    .query(&[("access_token", token)])
                    .send()
                    .await?
            }
        }
    } else {
        http()?.get(url).bearer_auth(token).send().await?
    };
    if !response.status().is_success() {
        return Err(NimbusError::Validation(format!(
            "授权验证失败：HTTP {}",
            response.status()
        )));
    }
    if provider == "baidu" {
        let payload: serde_json::Value = response.json().await?;
        let errno = payload
            .get("errno")
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        if errno != 0 {
            let message = payload
                .get("errmsg")
                .and_then(|value| value.as_str())
                .unwrap_or("未知错误");
            return Err(NimbusError::Validation(format!(
                "百度授权验证失败（{errno}）：{message}"
            )));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct BaiduList {
    #[serde(default)]
    list: Vec<BaiduFile>,
    #[serde(default)]
    errno: i64,
    errmsg: Option<String>,
}

#[derive(Deserialize)]
struct BaiduFile {
    fs_id: u64,
    path: String,
    server_filename: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    isdir: u8,
    #[serde(default)]
    server_mtime: Option<i64>,
    md5: Option<String>,
}

#[derive(Deserialize)]
struct BaiduMetaList {
    #[serde(default)]
    list: Vec<BaiduFileMeta>,
    #[serde(default)]
    errno: i64,
    errmsg: Option<String>,
}

#[derive(Deserialize)]
struct BaiduFileMeta {
    fs_id: u64,
    dlink: Option<String>,
}

pub async fn baidu_download_url(token: &str, fs_id: u64) -> Result<String> {
    let fsids = format!("[{fs_id}]");
    let query = [
        ("method", "filemetas"),
        ("access_token", token),
        ("fsids", fsids.as_str()),
        ("dlink", "1"),
    ];
    let response = match http()?
        .get("https://pan.baidu.com/rest/2.0/xpan/multimedia")
        .query(&query)
        .send()
        .await
    {
        Ok(res) => res,
        Err(err) => {
            eprintln!("Baidu download URL via default client failed ({err}), retrying directly without proxy...");
            direct_http()?
                .get("https://pan.baidu.com/rest/2.0/xpan/multimedia")
                .query(&query)
                .send()
                .await?
        }
    };
    if !response.status().is_success() {
        return Err(NimbusError::Validation(format!(
            "百度网盘读取下载地址失败：HTTP {}",
            response.status()
        )));
    }
    let metadata: BaiduMetaList = response.json().await?;
    if metadata.errno != 0 {
        return Err(NimbusError::Validation(format!(
            "百度网盘读取下载地址失败（{}）：{}",
            metadata.errno,
            metadata.errmsg.unwrap_or_else(|| "未知错误".into())
        )));
    }
    metadata
        .list
        .into_iter()
        .find(|item| item.fs_id == fs_id)
        .and_then(|item| item.dlink)
        .ok_or_else(|| NimbusError::Validation("百度没有返回该视频的下载地址".into()))
}

async fn list_baidu_directory(
    http: Client,
    token: String,
    directory: String,
    limit: usize,
) -> Result<Vec<BaiduFile>> {
    let page_size = 1000usize;
    let mut start = 0usize;
    let mut files = Vec::new();
    loop {
        let query = [
            ("method", "list".to_owned()),
            ("access_token", token.clone()),
            ("dir", directory.clone()),
            ("order", "name".to_owned()),
            ("desc", "0".to_owned()),
            ("start", start.to_string()),
            ("limit", page_size.to_string()),
            ("web", "0".to_owned()),
        ];
        let response = match http
            .get("https://pan.baidu.com/rest/2.0/xpan/file")
            .query(&query)
            .send()
            .await
        {
            Ok(res) => res,
            Err(err) => {
                eprintln!("Baidu list directory via default client failed ({err}), retrying directly without proxy...");
                direct_http()?
                    .get("https://pan.baidu.com/rest/2.0/xpan/file")
                    .query(&query)
                    .send()
                    .await?
            }
        };
        if !response.status().is_success() {
            return Err(NimbusError::Validation(format!(
                "百度网盘读取目录失败：HTTP {}",
                response.status()
            )));
        }
        let page: BaiduList = response.json().await?;
        if page.errno != 0 {
            return Err(NimbusError::Validation(format!(
                "百度网盘读取目录失败（{}）：{}",
                page.errno,
                page.errmsg.unwrap_or_else(|| "接口未返回错误说明".into())
            )));
        }
        let count = page.list.len();
        files.extend(page.list);
        if count < page_size || files.len() >= limit {
            break;
        }
        start += count;
    }
    Ok(files)
}

async fn scan_baidu(
    account_id: &str,
    token: &str,
    remote_root: &str,
    media_kind: &str,
    limit: usize,
) -> Result<(Vec<MediaFile>, ScanResult)> {
    let http = http()?;
    let mut directories = 0usize;
    let mut discovered = 0usize;
    let mut matched_files = Vec::new();
    let root = if remote_root.is_empty() {
        "/"
    } else {
        remote_root
    };
    let mut queue = VecDeque::from([root.to_owned()]);
    let mut visited = HashSet::from([root.to_owned()]);
    while !queue.is_empty() && discovered + directories < limit {
        let batch: Vec<_> = (0..8).filter_map(|_| queue.pop_front()).collect();
        let mut tasks = tokio::task::JoinSet::new();
        for directory in batch {
            tasks.spawn(list_baidu_directory(
                http.clone(),
                token.to_owned(),
                directory,
                limit.saturating_sub(discovered + directories),
            ));
        }
        while let Some(result) = tasks.join_next().await {
            let files = result
                .map_err(|error| NimbusError::Internal(format!("百度扫描任务失败：{error}")))??;
            directories += 1;
            for file in files {
                if file.isdir != 0 {
                    if visited.insert(file.path.clone()) {
                        queue.push_back(file.path.clone());
                    }
                } else {
                    discovered += 1;
                    if is_media(&file.server_filename, media_kind) {
                        matched_files.push(file);
                    }
                }
                if discovered + directories >= limit {
                    break;
                }
            }
        }
    }

    let media: Vec<_> = matched_files
        .into_iter()
        .map(|file| MediaFile {
            id: Uuid::new_v4().to_string(),
            account_id: account_id.into(),
            remote_path: format!("baidu://{}", file.fs_id),
            cloud_path: Some(file.path),
            display_name: file.server_filename,
            size: file.size,
            etag: file.md5,
            mime_type: None,
            source_id: None,
            source_ids: Vec::new(),
            media_kind: None,
        })
        .collect();
    Ok((
        media.clone(),
        ScanResult {
            visited_directories: directories,
            discovered_files: discovered,
            media_files: media.len(),
            truncated: discovered + directories >= limit,
        },
    ))
}

pub async fn browse(provider: &str, token: &str, path: &str) -> Result<Vec<CloudEntry>> {
    if matches!(provider, "google_drive" | "onedrive") {
        return browse_official(provider, token, path).await;
    }
    if provider != "baidu" {
        return Err(NimbusError::Validation("这个网盘的目录浏览尚未接入".into()));
    }
    let path = if path.is_empty() { "/" } else { path };
    let mut entries: Vec<_> =
        list_baidu_directory(http()?, token.to_owned(), path.to_owned(), usize::MAX)
            .await?
            .into_iter()
            .map(|file| CloudEntry {
                id: file.fs_id.to_string(),
                path: file.path,
                name: file.server_filename,
                is_dir: file.isdir != 0,
                size: file.size,
                modified_at: file.server_mtime,
            })
            .collect();
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

pub async fn copy_baidu(token: &str, source: &str, destination_directory: &str) -> Result<()> {
    let name = source
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NimbusError::Validation("复制来源路径无效".into()))?;
    let destination = if destination_directory == "/" {
        "/".to_owned()
    } else {
        destination_directory.trim_end_matches('/').to_owned()
    };
    let file_list = serde_json::to_string(&[serde_json::json!({
        "path": source,
        "dest": destination,
        "newname": name,
        "ondup": "newcopy"
    })])?;
    let response: serde_json::Value = http()?
        .post("https://pan.baidu.com/rest/2.0/xpan/file")
        .query(&[
            ("method", "filemanager"),
            ("access_token", token),
            ("opera", "copy"),
        ])
        .form(&[("async", "0"), ("filelist", file_list.as_str())])
        .send()
        .await?
        .json()
        .await?;
    let errno = response
        .get("errno")
        .and_then(|value| value.as_i64())
        .unwrap_or(-1);
    if errno != 0 {
        return Err(NimbusError::Validation(format!(
            "百度网盘复制失败（{errno}）"
        )));
    }
    Ok(())
}

pub async fn create_baidu_folder(token: &str, parent: &str, name: &str) -> Result<String> {
    let path = format!("{}/{}", parent.trim_end_matches('/'), name.trim());
    let path = if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    };
    let response: serde_json::Value = http()?
        .post("https://pan.baidu.com/rest/2.0/xpan/file")
        .query(&[("method", "create"), ("access_token", token)])
        .form(&[
            ("path", path.as_str()),
            ("size", "0"),
            ("isdir", "1"),
            ("block_list", "[]"),
            ("rtype", "3"),
        ])
        .send()
        .await?
        .json()
        .await?;
    let errno = response
        .get("errno")
        .and_then(|value| value.as_i64())
        .unwrap_or(-1);
    if errno != 0 {
        return Err(NimbusError::Validation(format!(
            "百度网盘新建文件夹失败（{errno}）"
        )));
    }
    Ok(response
        .get("path")
        .and_then(|value| value.as_str())
        .unwrap_or(&path)
        .to_owned())
}

fn baidu_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

async fn read_chunk(file: &mut tokio::fs::File, buffer: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        let count = file.read(&mut buffer[filled..]).await?;
        if count == 0 {
            break;
        }
        filled += count;
    }
    Ok(filled)
}

async fn baidu_block_hashes(path: &Path) -> Result<Vec<String>> {
    const BLOCK_SIZE: usize = 4 * 1024 * 1024;
    let mut file = tokio::fs::File::open(path).await?;
    let mut buffer = vec![0; BLOCK_SIZE];
    let mut hashes = Vec::new();
    loop {
        let count = read_chunk(&mut file, &mut buffer).await?;
        if count == 0 {
            break;
        }
        hashes.push(format!("{:x}", md5::compute(&buffer[..count])));
    }
    if hashes.is_empty() {
        hashes.push(format!("{:x}", md5::compute([])));
    }
    Ok(hashes)
}

async fn upload_baidu_file(token: &str, local_path: &Path, remote_path: &str) -> Result<()> {
    const BLOCK_SIZE: usize = 4 * 1024 * 1024;
    let size = tokio::fs::metadata(local_path).await?.len().to_string();
    let hashes = baidu_block_hashes(local_path).await?;
    let block_list = serde_json::to_string(&hashes)?;
    let precreate: serde_json::Value = http()?
        .post("https://pan.baidu.com/rest/2.0/xpan/file")
        .query(&[("method", "precreate"), ("access_token", token)])
        .form(&[
            ("path", remote_path),
            ("size", size.as_str()),
            ("isdir", "0"),
            ("autoinit", "1"),
            ("block_list", block_list.as_str()),
            ("rtype", "3"),
        ])
        .send()
        .await?
        .json()
        .await?;
    let errno = precreate
        .get("errno")
        .and_then(|value| value.as_i64())
        .unwrap_or(-1);
    if errno != 0 {
        return Err(NimbusError::Validation(format!(
            "百度网盘预创建失败（{errno}）"
        )));
    }
    if precreate
        .get("return_type")
        .and_then(|value| value.as_i64())
        == Some(2)
    {
        return Ok(());
    }
    let upload_id = precreate
        .get("uploadid")
        .and_then(|value| value.as_str())
        .ok_or_else(|| NimbusError::Validation("百度网盘未返回上传标识".into()))?;
    let file_name = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("upload.bin");
    let mut file = tokio::fs::File::open(local_path).await?;
    let mut buffer = vec![0; BLOCK_SIZE];
    let mut part = 0usize;
    loop {
        let count = read_chunk(&mut file, &mut buffer).await?;
        if count == 0 {
            break;
        }
        let form = reqwest::multipart::Form::new().part(
            "file",
            reqwest::multipart::Part::bytes(buffer[..count].to_vec())
                .file_name(file_name.to_owned()),
        );
        let response = http()?
            .post("https://d.pcs.baidu.com/rest/2.0/pcs/superfile2")
            .query(&[
                ("method", "upload".to_owned()),
                ("type", "tmpfile".to_owned()),
                ("access_token", token.to_owned()),
                ("path", remote_path.to_owned()),
                ("uploadid", upload_id.to_owned()),
                ("partseq", part.to_string()),
            ])
            .multipart(form)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(NimbusError::Validation(format!(
                "百度网盘分片上传失败：HTTP {}",
                response.status()
            )));
        }
        part += 1;
    }
    let created: serde_json::Value = http()?
        .post("https://pan.baidu.com/rest/2.0/xpan/file")
        .query(&[("method", "create"), ("access_token", token)])
        .form(&[
            ("path", remote_path),
            ("size", size.as_str()),
            ("isdir", "0"),
            ("uploadid", upload_id),
            ("block_list", block_list.as_str()),
            ("rtype", "3"),
        ])
        .send()
        .await?
        .json()
        .await?;
    let errno = created
        .get("errno")
        .and_then(|value| value.as_i64())
        .unwrap_or(-1);
    if errno != 0 {
        return Err(NimbusError::Validation(format!(
            "百度网盘合并上传失败（{errno}）"
        )));
    }
    Ok(())
}

pub async fn upload_baidu_entry(token: &str, source: &Path, destination: &str) -> Result<()> {
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| NimbusError::Validation("本地文件名称无效".into()))?;
    if source.is_file() {
        return upload_baidu_file(token, source, &baidu_path(destination, name)).await;
    }
    if !source.is_dir() {
        return Err(NimbusError::Validation("复制来源不存在".into()));
    }
    let remote_root = create_baidu_folder(token, destination, name).await?;
    let mut queue = VecDeque::from([(source.to_owned(), remote_root)]);
    while let Some((local_directory, remote_directory)) = queue.pop_front() {
        let mut entries = tokio::fs::read_dir(&local_directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            let local_path = entry.path();
            let child_name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().await?.is_dir() {
                let child_remote =
                    create_baidu_folder(token, &remote_directory, &child_name).await?;
                queue.push_back((local_path, child_remote));
            } else {
                upload_baidu_file(
                    token,
                    &local_path,
                    &baidu_path(&remote_directory, &child_name),
                )
                .await?;
            }
        }
    }
    Ok(())
}

async fn download_baidu_file(token: &str, fs_id: u64, target: &Path) -> Result<()> {
    let url = url::Url::parse(&baidu_download_url(token, fs_id).await?)?;
    let mut response = match transfer_http()?.get(url.clone()).send().await {
        Ok(res) => res,
        Err(err) => {
            eprintln!("Baidu transfer via default client failed ({err}), retrying directly without proxy...");
            direct_transfer_http()?.get(url).send().await?
        }
    };
    if !response.status().is_success() {
        return Err(NimbusError::Validation(format!(
            "百度网盘下载失败：HTTP {}",
            response.status()
        )));
    }
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = target.with_extension(format!("{}.nimbus-download", Uuid::new_v4().simple()));
    let _cleanup = TemporaryFile(temporary.clone());
    let expected = response.content_length();
    let mut received = 0u64;
    let mut output = tokio::fs::File::create(&temporary).await?;
    while let Some(chunk) = response.chunk().await? {
        output.write_all(&chunk).await?;
        received += chunk.len() as u64;
    }
    if expected.is_some_and(|size| size != received) {
        return Err(NimbusError::Validation("下载不完整，请重试".into()));
    }
    output.flush().await?;
    drop(output);
    if let Err(error) = tokio::fs::hard_link(&temporary, target).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error.into());
    }
    Ok(())
}

pub async fn download_baidu_entry(
    token: &str,
    source_path: &str,
    source_fs_id: Option<u64>,
    is_directory: bool,
    destination: PathBuf,
) -> Result<()> {
    if !is_directory {
        let fs_id =
            source_fs_id.ok_or_else(|| NimbusError::Validation("百度文件缺少文件标识".into()))?;
        return download_baidu_file(token, fs_id, &destination).await;
    }

    tokio::fs::create_dir_all(&destination).await?;
    let client = http()?;
    let mut queue = VecDeque::from([source_path.to_owned()]);
    while let Some(directory) = queue.pop_front() {
        let entries =
            list_baidu_directory(client.clone(), token.to_owned(), directory, usize::MAX).await?;
        for entry in entries {
            let relative = entry
                .path
                .strip_prefix(source_path)
                .unwrap_or(&entry.server_filename)
                .trim_start_matches('/');
            if std::path::Path::new(relative)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err(NimbusError::Validation("网盘返回了无效文件路径".into()));
            }
            let target = destination.join(relative);
            if entry.isdir != 0 {
                tokio::fs::create_dir_all(&target).await?;
                queue.push_back(entry.path);
            } else {
                download_baidu_file(token, entry.fs_id, &target).await?;
            }
        }
    }
    Ok(())
}

pub async fn scan_root(
    provider: &str,
    account_id: &str,
    token: &str,
    remote_root: &str,
    media_kind: &str,
    limit: usize,
) -> Result<(Vec<MediaFile>, ScanResult)> {
    match provider {
        "baidu" => scan_baidu(account_id, token, remote_root, media_kind, limit).await,
        "google_drive" | "onedrive" => {
            scan_official(provider, account_id, token, remote_root, media_kind, limit).await
        }
        _ => Err(NimbusError::Validation(
            "这个网盘的目录媒体扫描尚未接入".into(),
        )),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleList {
    #[serde(default)]
    files: Vec<GoogleFile>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleFile {
    id: String,
    name: String,
    mime_type: String,
    #[serde(default)]
    size: String,
}

#[derive(Deserialize)]
struct OneDriveList {
    #[serde(default)]
    value: Vec<OneDriveItem>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Deserialize)]
struct OneDriveItem {
    id: String,
    name: String,
    #[serde(default)]
    size: u64,
    folder: Option<serde_json::Value>,
}

const GOOGLE_FOLDER: &str = "application/vnd.google-apps.folder";

// Google Drive and OneDrive are browsed by folder names, like every other provider, so a file has
// one path in Files and in the library ("/电影/繁花/第01集.mkv"): 在文件中显示, reading memory and
// grouping agree, and the path bar shows names. The APIs list folders by id; the ids met while
// listing are remembered, so walking down needs no extra requests. A path maps to the folder's id
// and to its path spelled with names; the two differ only for id chains saved by older versions.
type FolderIds = HashMap<String, (String, String)>;
fn folder_ids() -> &'static parking_lot::Mutex<FolderIds> {
    static IDS: std::sync::OnceLock<parking_lot::Mutex<FolderIds>> = std::sync::OnceLock::new();
    IDS.get_or_init(Default::default)
}
/// One drive is told from another by a digest of its token.
fn folder_key(provider: &str, token: &str, path: &str) -> String {
    format!(
        "{provider}:{:x}:{}",
        md5::compute(token),
        path.trim_end_matches('/')
    )
}
fn remember_folder(provider: &str, token: &str, path: &str, id: &str, named: &str) {
    let mut ids = folder_ids().lock();
    if ids.len() >= 20_000 {
        ids.clear();
    }
    ids.insert(
        folder_key(provider, token, path),
        (id.to_owned(), named.to_owned()),
    );
}
/// A name as one path segment. Google Drive allows "/" in names; paths show it as "／".
fn official_child_path(parent: &str, name: &str) -> String {
    format!(
        "{}/{}",
        parent.trim_end_matches('/'),
        name.replace('/', "／")
    )
}
fn is_item_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '!'))
}
/// Older versions saved chains of ids ("/1AbC…/1QwE…") as paths.
fn looks_like_item_id(segment: &str) -> bool {
    segment.len() >= 16 && is_item_id(segment)
}
/// The Drive search for a child folder by name.
fn google_folder_query(parent: &str, segment: &str) -> String {
    let named = |name: &str| {
        format!(
            "name = '{}'",
            name.replace('\\', "\\\\").replace('\'', "\\'")
        )
    };
    let mut names = named(segment);
    if segment.contains('／') {
        names = format!("{names} or {}", named(&segment.replace('／', "/")));
    }
    format!(
        "'{parent}' in parents and trashed = false and mimeType = '{GOOGLE_FOLDER}' and ({names})"
    )
}
/// OneDrive addresses an item by name below its folder: `…/items/{id}:/{name}`.
fn onedrive_child_url(parent: &str, segment: &str) -> Result<url::Url> {
    let mut url = url::Url::parse(&if parent == "root" {
        "https://graph.microsoft.com/v1.0/me/drive/root:".to_owned()
    } else {
        format!("https://graph.microsoft.com/v1.0/me/drive/items/{parent}:")
    })?;
    url.path_segments_mut()
        .map_err(|_| NimbusError::Internal("OneDrive 地址无效".into()))?
        .push(segment);
    url.set_query(Some("$select=id,name,folder"));
    Ok(url)
}
async fn official_child_folder(
    provider: &str,
    client: &Client,
    token: &str,
    parent: &str,
    segment: &str,
) -> Result<Option<String>> {
    if matches!(segment, "." | "..") {
        return Ok(None);
    }
    if provider == "google_drive" {
        let query = google_folder_query(parent, segment);
        let page: GoogleList = client
            .get("https://www.googleapis.com/drive/v3/files")
            .bearer_auth(token)
            .query(&[
                ("q", query.as_str()),
                ("pageSize", "10"),
                ("fields", "files(id,name,mimeType)"),
                ("supportsAllDrives", "true"),
                ("includeItemsFromAllDrives", "true"),
            ])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        return Ok(page
            .files
            .into_iter()
            .map(|file| file.id)
            .find(|id| is_item_id(id)));
    }
    let response = client
        .get(onedrive_child_url(parent, segment)?)
        .bearer_auth(token)
        .send()
        .await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let item: OneDriveItem = response.error_for_status()?.json().await?;
    Ok(item
        .folder
        .is_some()
        .then_some(item.id)
        .filter(|id| is_item_id(id)))
}
/// The name of the folder with this id, or `None` when it is not a folder.
async fn official_folder_name(
    provider: &str,
    client: &Client,
    token: &str,
    id: &str,
) -> Result<Option<String>> {
    let url = if provider == "google_drive" {
        format!("https://www.googleapis.com/drive/v3/files/{id}?fields=id,name,mimeType&supportsAllDrives=true")
    } else {
        format!("https://graph.microsoft.com/v1.0/me/drive/items/{id}?$select=id,name,folder")
    };
    let response = client.get(url).bearer_auth(token).send().await?;
    if matches!(
        response.status(),
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::BAD_REQUEST
    ) {
        return Ok(None);
    }
    let response = response.error_for_status()?;
    Ok(if provider == "google_drive" {
        let file = response.json::<GoogleFile>().await?;
        (file.mime_type == GOOGLE_FOLDER).then_some(file.name)
    } else {
        let item = response.json::<OneDriveItem>().await?;
        item.folder.is_some().then_some(item.name)
    })
}
/// The id of the folder at a name path, and the path spelled with names. A segment that names no
/// folder but is a folder's id still resolves, so media folders saved as id chains by older
/// versions keep working, and what is listed or scanned below them gets name paths too.
async fn official_folder(
    provider: &str,
    client: &Client,
    token: &str,
    path: &str,
) -> Result<(String, String)> {
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let prefix = |end: usize| format!("/{}", segments[..end].join("/"));
    let (mut folder, mut start) = (("root".to_owned(), "/".to_owned()), 0);
    {
        let ids = folder_ids().lock();
        for end in (1..=segments.len()).rev() {
            if let Some(found) = ids.get(&folder_key(provider, token, &prefix(end))) {
                (folder, start) = (found.clone(), end);
                break;
            }
        }
    }
    for end in start + 1..=segments.len() {
        let segment = segments[end - 1];
        let missing = || {
            NimbusError::Validation(format!(
                "找不到文件夹“{segment}”，它可能已被移动、重命名或删除"
            ))
        };
        let child = official_child_folder(provider, client, token, &folder.0, segment).await?;
        let (id, name) = match child {
            Some(child) => (child, segment.to_owned()),
            None if looks_like_item_id(segment) => {
                let name = official_folder_name(provider, client, token, segment).await?;
                (segment.to_owned(), name.ok_or_else(missing)?)
            }
            None => return Err(missing()),
        };
        folder = (id, official_child_path(&folder.1, &name));
        remember_folder(provider, token, &prefix(end), &folder.0, &folder.1);
        remember_folder(provider, token, &folder.1, &folder.0, &folder.1);
    }
    Ok(folder)
}
async fn browse_official(provider: &str, token: &str, path: &str) -> Result<Vec<CloudEntry>> {
    let client = http()?;
    let (id, named) = official_folder(provider, &client, token, path).await?;
    list_official(provider, &client, token, &named, &id).await
}
/// The children of the folder `id`, found at the name path `path`.
async fn list_official(
    provider: &str,
    client: &Client,
    token: &str,
    path: &str,
    id: &str,
) -> Result<Vec<CloudEntry>> {
    if !is_item_id(id) {
        return Err(NimbusError::Validation("无效的云盘目录标识".into()));
    }
    let mut entries = Vec::new();
    if provider == "google_drive" {
        let mut cursor: Option<String> = None;
        loop {
            let query = format!("'{}' in parents and trashed=false", id);
            let mut request = client
                .get("https://www.googleapis.com/drive/v3/files")
                .bearer_auth(token)
                .query(&[
                    ("q", query.as_str()),
                    ("pageSize", "1000"),
                    (
                        "fields",
                        "nextPageToken,files(id,name,mimeType,size,md5Checksum)",
                    ),
                    ("supportsAllDrives", "true"),
                    ("includeItemsFromAllDrives", "true"),
                ]);
            if let Some(cursor) = &cursor {
                request = request.query(&[("pageToken", cursor)]);
            }
            let page: GoogleList = request.send().await?.error_for_status()?.json().await?;
            entries.extend(page.files.into_iter().map(|file| CloudEntry {
                path: official_child_path(path, &file.name),
                id: file.id,
                name: file.name,
                is_dir: file.mime_type == GOOGLE_FOLDER,
                size: file.size.parse().unwrap_or(0),
                modified_at: None,
            }));
            cursor = page.next_page_token;
            if cursor.is_none() {
                break;
            }
        }
    } else {
        let mut next = Some(if id == "root" {
            "https://graph.microsoft.com/v1.0/me/drive/root/children?$top=200".into()
        } else {
            format!("https://graph.microsoft.com/v1.0/me/drive/items/{id}/children?$top=200")
        });
        while let Some(url) = next {
            let parsed = url::Url::parse(&url)?;
            if parsed.scheme() != "https" || parsed.host_str() != Some("graph.microsoft.com") {
                return Err(NimbusError::Validation("OneDrive 返回无效分页地址".into()));
            }
            let page: OneDriveList = client
                .get(parsed)
                .bearer_auth(token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            entries.extend(page.value.into_iter().map(|file| CloudEntry {
                path: official_child_path(path, &file.name),
                id: file.id,
                name: file.name,
                is_dir: file.folder.is_some(),
                size: file.size,
                modified_at: None,
            }));
            next = page.next_link;
        }
    }
    for entry in entries.iter().filter(|entry| entry.is_dir) {
        remember_folder(provider, token, &entry.path, &entry.id, &entry.path);
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(entries)
}
/// Files are stored with the same name paths Files shows, from the drive's root.
async fn scan_official(
    provider: &str,
    account: &str,
    token: &str,
    root: &str,
    kind: &str,
    limit: usize,
) -> Result<(Vec<MediaFile>, ScanResult)> {
    let client = http()?;
    let (root_id, root_path) = official_folder(provider, &client, token, root).await?;
    let mut queue = VecDeque::from([(root_path, root_id)]);
    let mut seen = HashSet::new();
    let mut result = ScanResult {
        visited_directories: 0,
        discovered_files: 0,
        media_files: 0,
        truncated: false,
    };
    let mut files = Vec::new();
    while let Some((path, id)) = queue.pop_front() {
        if !seen.insert(id.clone()) {
            continue;
        }
        result.visited_directories += 1;
        for entry in list_official(provider, &client, token, &path, &id).await? {
            if result.discovered_files + result.visited_directories >= limit {
                result.truncated = true;
                break;
            }
            if entry.is_dir {
                queue.push_back((entry.path, entry.id));
                continue;
            }
            result.discovered_files += 1;
            if !is_media(&entry.name, kind) {
                continue;
            }
            let remote_path = if provider == "google_drive" {
                format!(
                    "https://www.googleapis.com/drive/v3/files/{}?alt=media&supportsAllDrives=true",
                    entry.id
                )
            } else {
                format!(
                    "https://graph.microsoft.com/v1.0/me/drive/items/{}/content",
                    entry.id
                )
            };
            files.push(MediaFile {
                id: Uuid::new_v4().to_string(),
                account_id: account.into(),
                remote_path,
                cloud_path: Some(entry.path),
                display_name: entry.name,
                size: entry.size,
                etag: None,
                mime_type: None,
                source_id: None,
                source_ids: Vec::new(),
                media_kind: None,
            });
        }
        if result.truncated {
            break;
        }
    }
    result.media_files = files.len();
    Ok((files, result))
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn official_paths_are_names_from_the_drive_root() {
        assert_eq!(official_child_path("/", "电影"), "/电影");
        assert_eq!(official_child_path("/电影/", "繁花"), "/电影/繁花");
        // A Google Drive name with "/" stays one segment.
        assert_eq!(official_child_path("/音乐", "AC/DC"), "/音乐/AC／DC");
    }

    #[test]
    fn folder_lookups_quote_names_and_encode_paths() {
        let query = google_folder_query("root", r"Tom's \ 电影");
        assert!(query.starts_with("'root' in parents and trashed = false"));
        assert!(query.ends_with(r"(name = 'Tom\'s \\ 电影')"));
        let query = google_folder_query("1AbC", "AC／DC");
        assert!(query.ends_with("(name = 'AC／DC' or name = 'AC/DC')"));

        assert_eq!(
            onedrive_child_url("root", "繁花 #1?").unwrap().as_str(),
            "https://graph.microsoft.com/v1.0/me/drive/root:/%E7%B9%81%E8%8A%B1%20%231%3F?$select=id,name,folder"
        );
        assert_eq!(
            onedrive_child_url("D4648F06C91D9D3D!54927", "Movies").unwrap().as_str(),
            "https://graph.microsoft.com/v1.0/me/drive/items/D4648F06C91D9D3D!54927:/Movies?$select=id,name,folder"
        );
    }

    #[test]
    fn only_id_shaped_segments_fall_back_to_ids() {
        assert!(looks_like_item_id("1AbCdEfGhIjKlMnOpQrStUvWxYz"));
        assert!(looks_like_item_id("D4648F06C91D9D3D!54927"));
        assert!(!looks_like_item_id("电影"));
        assert!(!looks_like_item_id("Season1"));
        assert!(!is_item_id("a/b"));
        assert!(!is_item_id("a?b"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_direct_http_connectivity() {
        let client = direct_http().expect("direct_http should build");
        let res = client
            .post("https://openapi.baidu.com/oauth/2.0/token")
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", "test_code"),
                ("client_id", "test_key"),
                ("client_secret", "test_secret"),
                ("redirect_uri", "http://127.0.0.1:8080"),
            ])
            .send()
            .await;
        assert!(
            res.is_ok(),
            "Direct HTTP request to Baidu openapi should succeed: {:?}",
            res.err()
        );
    }

    #[tokio::test]
    async fn test_default_http_with_socks_proxy() {
        let client = http().expect("http client should build");
        let res = client
            .post("https://openapi.baidu.com/oauth/2.0/token")
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", "test_code"),
                ("client_id", "test_key"),
                ("client_secret", "test_secret"),
                ("redirect_uri", "http://127.0.0.1:8080"),
            ])
            .send()
            .await;
        // Even if proxy has an issue, it should either succeed or fail gracefully, but with socks support compiled in,
        // it must NOT fail with "unsupported scheme socks5".
        if let Err(e) = &res {
            let err_str = format!("{e:?}");
            assert!(
                !err_str.contains("unsupported scheme socks5"),
                "Must not fail with unsupported scheme socks5: {err_str}"
            );
        }
    }
}
