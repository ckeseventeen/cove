use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
};

use uuid::Uuid;

use crate::{
    error::{NimbusError, Result},
    model::{CloudEntry, MediaFile, ScanResult},
};

const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "m4v", "mov", "avi", "webm", "ts", "m2ts", "flv", "wmv",
];
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "ape"];

fn normalized(path: &str) -> Result<PathBuf> {
    let path = if path.trim().is_empty() {
        "/"
    } else {
        path.trim()
    };
    let value = PathBuf::from(path);
    if !value.is_absolute() {
        return Err(NimbusError::Validation("本地路径必须是绝对路径".into()));
    }
    Ok(value)
}

fn media_matches(path: &Path, kind: &str) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    let extension = extension.to_ascii_lowercase();
    if kind == "music" {
        AUDIO_EXTENSIONS.contains(&extension.as_str())
    } else {
        VIDEO_EXTENSIONS.contains(&extension.as_str())
    }
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_else(|| path.to_str().unwrap_or("本地磁盘"))
        .to_owned()
}

pub fn browse(path: &str) -> Result<Vec<CloudEntry>> {
    if path.trim().is_empty() || path.trim() == "/" {
        let mut roots = Vec::new();
        if let Ok(home) = std::env::var("HOME") {
            roots.push(CloudEntry {
                id: home.clone(),
                path: home,
                name: "个人文件夹".into(),
                is_dir: true,
                size: 0,
                modified_at: None,
            });
        }
        roots.push(CloudEntry {
            id: "/Volumes".into(),
            path: "/Volumes".into(),
            name: "磁盘与外置设备".into(),
            is_dir: true,
            size: 0,
            modified_at: None,
        });
        roots.push(CloudEntry {
            id: "/Users/Shared".into(),
            path: "/Users/Shared".into(),
            name: "共享文件".into(),
            is_dir: true,
            size: 0,
            modified_at: None,
        });
        return Ok(roots);
    }
    let directory = normalized(path)?;
    if !directory.is_dir() {
        return Err(NimbusError::Validation("本地目录不存在或无法访问".into()));
    }
    let mut entries = Vec::new();
    for item in fs::read_dir(&directory)
        .map_err(|error| NimbusError::Validation(format!("无法读取本地目录：{error}")))?
    {
        let item = match item {
            Ok(item) => item,
            Err(_) => continue,
        };
        let path = item.path();
        let name = display_name(&path);
        if name.starts_with('.') {
            continue;
        }
        let metadata = match item.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);
        entries.push(CloudEntry {
            id: path.to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified_at,
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn scan_root(
    account_id: &str,
    root: &str,
    kind: &str,
    limit: usize,
) -> Result<(Vec<MediaFile>, ScanResult)> {
    let root = normalized(root)?;
    let mut queue = VecDeque::from([root]);
    let mut directories = 0;
    let mut discovered = 0;
    let mut files = Vec::new();
    let mut truncated = false;
    while let Some(directory) = queue.pop_front() {
        directories += 1;
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                truncated = true;
                continue;
            }
        };
        for item in entries {
            let item = match item {
                Ok(item) => item,
                Err(_) => {
                    truncated = true;
                    continue;
                }
            };
            if discovered + directories >= limit {
                truncated = true;
                break;
            }
            let path = item.path();
            let name = display_name(&path);
            if name.starts_with('.') {
                continue;
            }
            let Ok(metadata) = item.metadata() else {
                truncated = true;
                continue;
            };
            if metadata.is_dir() {
                queue.push_back(path);
                continue;
            }
            discovered += 1;
            if media_matches(&path, kind) {
                let value = path.to_string_lossy().into_owned();
                files.push(MediaFile {
                    id: Uuid::new_v4().to_string(),
                    account_id: account_id.to_owned(),
                    remote_path: value.clone(),
                    cloud_path: Some(value),
                    display_name: name,
                    size: metadata.len(),
                    etag: None,
                    mime_type: None,
                    source_id: None,
                    source_ids: Vec::new(),
                    media_kind: None,
                });
            }
        }
        if truncated {
            break;
        }
    }
    let result = ScanResult {
        visited_directories: directories,
        discovered_files: discovered,
        media_files: files.len(),
        truncated,
    };
    Ok((files, result))
}

fn available_destination(directory: &Path, name: &str) -> PathBuf {
    let candidate = directory.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let source = Path::new(name);
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    let extension = source.extension().and_then(|value| value.to_str());
    for index in 1..10_000 {
        let new_name = match extension {
            Some(extension) => format!("{stem} 副本 {index}.{extension}"),
            None => format!("{stem} 副本 {index}"),
        };
        let candidate = directory.join(new_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem} 副本 {}", Uuid::new_v4()))
}

pub fn destination_for_new_entry(directory: &str, name: &str) -> Result<PathBuf> {
    let directory = normalized(directory)?;
    if !directory.is_dir() {
        return Err(NimbusError::Validation("复制目标不是文件夹".into()));
    }
    let safe_name = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NimbusError::Validation("复制来源名称无效".into()))?;
    Ok(available_destination(&directory, safe_name))
}

fn copy_file_exclusive(source: &Path, destination: &Path) -> Result<()> {
    let mut input = fs::File::open(source)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    if let Err(error) = std::io::copy(&mut input, &mut output) {
        drop(output);
        let _ = fs::remove_file(destination);
        return Err(error.into());
    }
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir(destination)?;
    for item in fs::read_dir(source)? {
        let item = item?;
        let source_path = item.path();
        let destination_path = destination.join(item.file_name());
        if item.file_type()?.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else {
            copy_file_exclusive(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

pub fn copy_entry(source: &str, destination_directory: &str) -> Result<String> {
    let source = normalized(source)?.canonicalize()?;
    let destination_directory = normalized(destination_directory)?.canonicalize()?;
    if !source.exists() || !destination_directory.is_dir() {
        return Err(NimbusError::Validation("复制来源或目标目录不存在".into()));
    }
    let name = display_name(&source);
    let destination = available_destination(&destination_directory, &name);
    if source.is_dir() {
        if destination.starts_with(&source) {
            return Err(NimbusError::Validation("不能把文件夹复制到自身内部".into()));
        }
        copy_directory(&source, &destination)?;
    } else {
        copy_file_exclusive(&source, &destination)?;
    }
    Ok(destination.to_string_lossy().into_owned())
}

pub fn create_folder(parent: &str, name: &str) -> Result<String> {
    let parent = normalized(parent)?;
    let name = name.trim();
    if name.is_empty() || matches!(name, "." | "..") || name.contains('/') {
        return Err(NimbusError::Validation("文件夹名称无效".into()));
    }
    let path = parent.join(name);
    fs::create_dir(&path)
        .map_err(|error| NimbusError::Validation(format!("无法新建文件夹：{error}")))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_destination_creation_never_overwrites() {
        let root = std::env::temp_dir().join(format!("nimbus-race-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, b"new").unwrap();
        fs::write(&destination, b"existing").unwrap();
        assert!(copy_file_exclusive(&source, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"existing");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_files_without_overwriting() {
        let root = std::env::temp_dir().join(format!("nimbus-local-test-{}", Uuid::new_v4()));
        let source_dir = root.join("source");
        let destination_dir = root.join("destination");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&destination_dir).unwrap();
        let source = source_dir.join("song.mp3");
        fs::write(&source, b"nimbus").unwrap();
        let first =
            copy_entry(source.to_str().unwrap(), destination_dir.to_str().unwrap()).unwrap();
        let second =
            copy_entry(source.to_str().unwrap(), destination_dir.to_str().unwrap()).unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read(first).unwrap(), b"nimbus");
        assert_eq!(fs::read(second).unwrap(), b"nimbus");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_media_in_nested_directories() {
        let root = std::env::temp_dir().join(format!("nimbus-scan-test-{}", Uuid::new_v4()));
        let nested = root.join("Artist/Album");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("track.flac"), b"audio").unwrap();
        fs::write(nested.join("cover.jpg"), b"image").unwrap();
        let (files, result) = scan_root("local", root.to_str().unwrap(), "music", 100).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(result.media_files, 1);
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod failure_tests {
    use super::*;
    #[test]
    fn unavailable_root_is_partial_not_empty_success() {
        let root = std::env::temp_dir().join(format!("nimbus-missing-{}", Uuid::new_v4()));
        let (files, result) = scan_root("local", root.to_str().unwrap(), "movie", 100).unwrap();
        assert!(files.is_empty());
        assert!(result.truncated);
    }
    #[test]
    fn limit_signals_partial_scan() {
        let root = std::env::temp_dir().join(format!("nimbus-limit-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        for name in ["a.mkv", "b.mkv", "c.mkv"] {
            fs::write(root.join(name), b"fixture").unwrap();
        }
        let (_, result) = scan_root("local", root.to_str().unwrap(), "movie", 2).unwrap();
        assert!(result.truncated);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cannot_copy_into_self_through_symlink() {
        let root = std::env::temp_dir().join(format!("nimbus-copy-{}", Uuid::new_v4()));
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        std::os::unix::fs::symlink(&source, root.join("alias")).unwrap();
        assert!(copy_entry(
            source.to_str().unwrap(),
            root.join("alias").to_str().unwrap()
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
