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

/// Left out of browsing and scans, as the system's file manager leaves it out: a dot file, and on
/// Windows also what is marked hidden or system ($Recycle.Bin, System Volume Information, the
/// "Documents and Settings" junction).
fn is_hidden(name: &str, item: &fs::DirEntry) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
        if item.metadata().is_ok_and(|metadata| metadata.file_attributes() & HIDDEN_OR_SYSTEM != 0) {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = item;
    name.starts_with('.')
}

fn normalized(path: &str) -> Result<PathBuf> {
    let path = if path.trim().is_empty() {
        "/"
    } else {
        path.trim()
    };
    let value = crate::paths::native(path);
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
    if kind == "document" {
        crate::media_types::DOCUMENT_EXTENSIONS.contains(&extension.as_str())
    } else if kind == "course" {
        // Lessons and their handouts.
        VIDEO_EXTENSIONS.contains(&extension.as_str()) || crate::media_types::DOCUMENT_EXTENSIONS.contains(&extension.as_str())
    } else if kind == "music" {
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

fn place(path: String, name: &str) -> CloudEntry {
    CloudEntry {
        id: path.clone(),
        path,
        name: name.into(),
        is_dir: true,
        size: 0,
        modified_at: None,
    }
}

/// What "/" shows: the home folder and the disks.
#[cfg(not(windows))]
fn roots() -> Vec<CloudEntry> {
    let mut roots = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        roots.push(place(home, "个人文件夹"));
    }
    roots.push(place("/Volumes".into(), "磁盘与外置设备"));
    roots.push(place("/Users/Shared".into(), "共享文件"));
    roots
}

/// What "/" shows: the home folder, then each drive as Explorer names it ("本地磁盘 (C:)").
#[cfg(windows)]
fn roots() -> Vec<CloudEntry> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        roots.push(place(crate::paths::portable(Path::new(&home)), "个人文件夹"));
    }
    let drives = unsafe { windows_sys::Win32::Storage::FileSystem::GetLogicalDrives() };
    for index in 0..26u8 {
        if drives & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index) as char;
        let root: Vec<u16> = format!("{letter}:\\\0").encode_utf16().collect();
        let kind = unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(root.as_ptr()) };
        let name = match kind {
            // DRIVE_REMOVABLE, DRIVE_REMOTE, DRIVE_CDROM
            2 => format!("可移动磁盘 ({letter}:)"),
            4 => format!("网络驱动器 ({letter}:)"),
            5 => continue,
            _ => format!("本地磁盘 ({letter}:)"),
        };
        roots.push(place(format!("/{letter}:"), &name));
    }
    roots
}

pub fn browse(path: &str) -> Result<Vec<CloudEntry>> {
    if path.trim().is_empty() || path.trim() == "/" {
        return Ok(roots());
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
        if is_hidden(&name, &item) {
            continue;
        }
        // Follow symlinks so aliased folders browse like folders, as in Finder.
        let metadata = match fs::metadata(&path).or_else(|_| item.metadata()) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);
        entries.push(CloudEntry {
            id: crate::paths::portable(&path),
            path: crate::paths::portable(&path),
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
    let mut queue = VecDeque::from([root.clone()]);
    let mut directories = 0;
    let mut discovered = 0;
    let mut files = Vec::new();
    let mut truncated = false;
    let mut skipped = Vec::new();
    'walk: while let Some(directory) = queue.pop_front() {
        directories += 1;
        let entries = fs::read_dir(&directory);
        let mut readable = entries.is_ok();
        for item in entries.into_iter().flatten() {
            let Ok(item) = item else {
                readable = false;
                break;
            };
            if discovered + directories >= limit {
                truncated = true;
                break 'walk;
            }
            let path = item.path();
            let name = display_name(&path);
            if is_hidden(&name, &item) {
                continue;
            }
            let metadata = match item.metadata() {
                Ok(metadata) => metadata,
                // Removed while scanning: nothing to index.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    readable = false;
                    break;
                }
            };
            if metadata.is_dir() {
                queue.push_back(path);
                continue;
            }
            discovered += 1;
            if media_matches(&path, kind) {
                let value = crate::paths::portable(&path);
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
        // A subfolder that cannot be read (permissions, macOS privacy protection) is skipped
        // and reported, and the walk goes on. Without the root there is nothing to update.
        if !readable {
            if directory == root {
                return Err(NimbusError::Validation(
                    "无法读取这个文件夹。请确认它仍然存在，并且 Cove 有权访问。".into(),
                ));
            }
            skipped.push(crate::paths::portable(&directory));
        }
    }
    let result = ScanResult {
        visited_directories: directories,
        discovered_files: discovered,
        media_files: files.len(),
        truncated,
        skipped_directories: skipped,
    };
    Ok((files, result))
}

/// Adds to `files` what the library already indexed for `source_id` inside folders the scan
/// had to skip, so the scan can complete without dropping them.
pub fn keep_skipped(
    files: &mut Vec<MediaFile>,
    indexed: Vec<MediaFile>,
    source_id: &str,
    skipped: &[String],
) {
    let inside = |path: &str| {
        skipped.iter().any(|directory| {
            path.strip_prefix(directory.trim_end_matches('/'))
                .is_some_and(|rest| rest.starts_with('/'))
        })
    };
    let found: std::collections::HashSet<_> =
        files.iter().map(|file| file.remote_path.clone()).collect();
    let kept: Vec<_> = indexed
        .into_iter()
        .filter(|file| {
            file.source_ids.iter().any(|id| id == source_id)
                && inside(&file.remote_path)
                && !found.contains(&file.remote_path)
        })
        .map(|file| MediaFile {
            // Matched by path like a freshly scanned file, keeping the indexed row and its id.
            id: Uuid::new_v4().to_string(),
            ..file
        })
        .collect();
    files.extend(kept);
}

/// A free name for a copy, as Finder picks one: "片.mkv" → "片 副本 1.mkv". A folder has no
/// extension, so "Season.1" becomes "Season.1 副本 1", not "Season 副本 1.1".
fn available_destination(directory: &Path, name: &str, is_dir: bool) -> PathBuf {
    let candidate = directory.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let source = Path::new(name);
    let (stem, extension) = if is_dir {
        (name, None)
    } else {
        (
            source.file_stem().and_then(|value| value.to_str()).unwrap_or(name),
            source.extension().and_then(|value| value.to_str()),
        )
    };
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

pub fn destination_for_new_entry(directory: &str, name: &str, is_dir: bool) -> Result<PathBuf> {
    let directory = normalized(directory)?;
    if !directory.is_dir() {
        return Err(NimbusError::Validation("复制目标不是文件夹".into()));
    }
    let safe_name = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NimbusError::Validation("复制来源名称无效".into()))?;
    Ok(available_destination(&directory, safe_name, is_dir))
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
    let destination = available_destination(&destination_directory, &name, source.is_dir());
    if source.is_dir() {
        if destination.starts_with(&source) {
            return Err(NimbusError::Validation("不能把文件夹复制到自身内部".into()));
        }
        copy_directory(&source, &destination)?;
    } else {
        copy_file_exclusive(&source, &destination)?;
    }
    Ok(crate::paths::portable(&destination))
}

pub fn create_folder(parent: &str, name: &str) -> Result<String> {
    let parent = normalized(parent)?;
    let name = name.trim();
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\']) {
        return Err(NimbusError::Validation("文件夹名称无效".into()));
    }
    let path = parent.join(name);
    fs::create_dir(&path)
        .map_err(|error| NimbusError::Validation(format!("无法新建文件夹：{error}")))?;
    Ok(crate::paths::portable(&path))
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
        assert_eq!(fs::read(crate::paths::native(&first)).unwrap(), b"nimbus");
        assert_eq!(fs::read(crate::paths::native(&second)).unwrap(), b"nimbus");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_of_dotted_folders_keep_their_whole_name() {
        let root = std::env::temp_dir().join(format!("nimbus-copy-name-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("Season.1")).unwrap();
        fs::write(root.join("Season.1/E01.mkv"), b"video").unwrap();
        let folder = copy_entry(root.join("Season.1").to_str().unwrap(), root.to_str().unwrap()).unwrap();
        assert!(folder.ends_with("Season.1 副本 1"), "{folder}");
        assert_eq!(fs::read(crate::paths::native(&folder).join("E01.mkv")).unwrap(), b"video");
        let file = copy_entry(root.join("Season.1/E01.mkv").to_str().unwrap(), root.join("Season.1").to_str().unwrap()).unwrap();
        assert!(file.ends_with("E01 副本 1.mkv"), "{file}");
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
    fn unavailable_root_fails_instead_of_empty_success() {
        let root = std::env::temp_dir().join(format!("nimbus-missing-{}", Uuid::new_v4()));
        assert!(scan_root("local", root.to_str().unwrap(), "movie", 100).is_err());
    }
    #[test]
    #[cfg(unix)]
    fn unreadable_subfolder_is_skipped_and_the_scan_goes_on() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("nimbus-skip-{}", Uuid::new_v4()));
        for folder in ["A_private", "B", "C/Deep"] {
            fs::create_dir_all(root.join(folder)).unwrap();
        }
        for file in ["A_private/a.mkv", "B/b.mkv", "C/Deep/c.mkv", "top.mkv"] {
            fs::write(root.join(file), b"fixture").unwrap();
        }
        let private = root.join("A_private");
        fs::set_permissions(&private, fs::Permissions::from_mode(0o000)).unwrap();
        // Permissions do not stop root (the superuser); nothing to check then.
        let enforced = fs::read_dir(&private).is_err();
        let scanned = scan_root("local", root.to_str().unwrap(), "movie", 100);
        fs::set_permissions(&private, fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_dir_all(&root).unwrap();
        if !enforced {
            return;
        }
        let (files, result) = scanned.unwrap();
        let mut names: Vec<_> = files.iter().map(|file| file.display_name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["b.mkv", "c.mkv", "top.mkv"]);
        assert!(!result.truncated);
        assert_eq!(
            result.skipped_directories,
            [private.to_string_lossy().into_owned()]
        );
    }
    #[test]
    fn files_in_skipped_folders_stay_in_the_library() {
        let file = |path: &str, sources: &[&str]| MediaFile {
            id: Uuid::new_v4().to_string(),
            account_id: "local".into(),
            remote_path: path.into(),
            cloud_path: Some(path.into()),
            display_name: path.rsplit('/').next().unwrap().into(),
            size: 1,
            etag: None,
            mime_type: None,
            source_id: sources.first().map(|id| id.to_string()),
            source_ids: sources.iter().map(|id| id.to_string()).collect(),
            media_kind: Some("movie".into()),
        };
        let indexed = vec![
            file("/Movies/private/a.mkv", &["movies"]),
            file("/Movies/private/deep/b.mkv", &["other", "movies"]),
            file("/Movies/private-2/c.mkv", &["movies"]),
            file("/Movies/d.mkv", &["movies"]),
            file("/Movies/private/e.mkv", &["other"]),
        ];
        let original = indexed[0].id.clone();
        // A folder that failed part-way through can already have been partly scanned.
        let mut files = vec![file("/Movies/private/deep/b.mkv", &[])];
        keep_skipped(&mut files, indexed, "movies", &["/Movies/private".into()]);
        let paths: Vec<_> = files.iter().map(|file| file.remote_path.as_str()).collect();
        assert_eq!(paths, ["/Movies/private/deep/b.mkv", "/Movies/private/a.mkv"]);
        // Re-saved by path like scanned files; the stored row keeps its own id.
        assert_ne!(files[1].id, original);
    }
    #[test]
    fn scan_with_a_skipped_folder_prunes_elsewhere_and_records_the_time() {
        use crate::{model::MediaSource, store::Store};
        let directory = std::env::temp_dir().join(format!("nimbus-skip-store-{}", Uuid::new_v4()));
        let store = Store::open(&directory.join("library.db")).unwrap();
        store.ensure_local_account().unwrap();
        let source = MediaSource {
            id: "movies".into(),
            account_id: "local".into(),
            kind: "movie".into(),
            remote_root: "/Movies".into(),
            label: "影视".into(),
            last_scan_at: None,
        };
        store.insert_media_source(&source).unwrap();
        let file = |path: &str| MediaFile {
            id: Uuid::new_v4().to_string(),
            account_id: "local".into(),
            remote_path: path.into(),
            cloud_path: Some(path.into()),
            display_name: path.rsplit('/').next().unwrap().into(),
            size: 1,
            etag: None,
            mime_type: None,
            source_id: None,
            source_ids: Vec::new(),
            media_kind: None,
        };
        let first = [file("/Movies/private/a.mkv"), file("/Movies/gone.mkv"), file("/Movies/b.mkv")];
        store.replace_source_files(&source, &first, true).unwrap();
        store.save_playback_progress(&first[0].id, 12.0, 100.0, 1.0).unwrap();

        // The next scan cannot read /Movies/private, and gone.mkv was deleted.
        let mut files = vec![file("/Movies/b.mkv")];
        keep_skipped(
            &mut files,
            store.list_media_files().unwrap(),
            &source.id,
            &["/Movies/private".into()],
        );
        store.replace_source_files(&source, &files, true).unwrap();

        let mut paths: Vec<_> = store
            .list_media_files()
            .unwrap()
            .into_iter()
            .map(|file| file.remote_path)
            .collect();
        paths.sort();
        assert_eq!(paths, ["/Movies/b.mkv", "/Movies/private/a.mkv"]);
        assert_eq!(store.playback_progress(&first[0].id).unwrap(), Some((12.0, 1.0)));
        assert!(store.get_media_source(&source.id).unwrap().last_scan_at.is_some());
        drop(store);
        let _ = fs::remove_dir_all(directory);
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
    #[cfg(unix)]
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
