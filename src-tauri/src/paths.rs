//! Local paths as the library stores them: absolute and "/"-separated on every system, so the web
//! UI splits and walks them one way. On Windows a drive path is written "/C:/Users/me/Videos" and a
//! network path "//nas/share/影视"; "/" itself lists the drives. On macOS a path is itself.
use std::path::{Path, PathBuf};

const WINDOWS: bool = cfg!(windows);

/// A path on this computer → the library's spelling of it.
pub fn portable(path: &Path) -> String {
    portable_from(&path.to_string_lossy(), WINDOWS)
}

/// The library's spelling of a path → the path on this computer.
pub fn native(path: &str) -> PathBuf {
    PathBuf::from(native_from(path, WINDOWS))
}

fn is_drive(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes.len() == 2 || bytes[2] == b'/')
}

pub(crate) fn portable_from(text: &str, windows: bool) -> String {
    if !windows {
        return text.to_owned();
    }
    let mut value = text.replace('\\', "/");
    // canonicalize() answers in the long form: "\\?\C:\…" and "\\?\UNC\nas\share\…".
    if let Some(rest) = value.strip_prefix("//?/UNC/") {
        value = format!("//{rest}");
    } else if let Some(rest) = value.strip_prefix("//?/") {
        value = rest.to_owned();
    }
    let trimmed = value.trim_end_matches('/');
    if is_drive(trimmed) {
        format!("/{trimmed}")
    } else if trimmed.is_empty() {
        "/".into()
    } else {
        trimmed.to_owned()
    }
}

pub(crate) fn native_from(text: &str, windows: bool) -> String {
    if !windows {
        return text.to_owned();
    }
    let value = text.replace('\\', "/");
    let value = if value.starts_with("//") {
        value
    } else {
        let rest = value.trim_start_matches('/');
        // "C:" alone means the current folder on drive C; the drive itself is "C:\".
        if is_drive(rest) && rest.len() == 2 {
            format!("{rest}/")
        } else {
            rest.to_owned()
        }
    };
    value.replace('/', "\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_paths_are_themselves() {
        assert_eq!(portable_from("/Users/me/影视/a.mkv", false), "/Users/me/影视/a.mkv");
        assert_eq!(native_from("/Volumes/NAS/a.mkv", false), "/Volumes/NAS/a.mkv");
    }

    #[test]
    fn windows_drives_live_under_the_root() {
        assert_eq!(portable_from(r"C:\Users\me\Videos\a.mkv", true), "/C:/Users/me/Videos/a.mkv");
        assert_eq!(portable_from(r"D:\", true), "/D:");
        assert_eq!(portable_from(r"\\?\C:\Users\me", true), "/C:/Users/me");
        assert_eq!(native_from("/C:/Users/me/Videos/a.mkv", true), r"C:\Users\me\Videos\a.mkv");
        assert_eq!(native_from("/D:", true), r"D:\");
        assert_eq!(native_from("/D:/", true), r"D:\");
    }

    #[test]
    fn windows_network_paths_keep_their_double_slash() {
        assert_eq!(portable_from(r"\\nas\影视\电影\a.mkv", true), "//nas/影视/电影/a.mkv");
        assert_eq!(portable_from(r"\\?\UNC\nas\影视\a.mkv", true), "//nas/影视/a.mkv");
        assert_eq!(native_from("//nas/影视/a.mkv", true), r"\\nas\影视\a.mkv");
    }

    #[test]
    fn spellings_round_trip() {
        for path in ["/C:/Users/me/课程/第一章", "//nas/share/Movies", "/E:"] {
            assert_eq!(portable_from(&native_from(path, true), true), path);
        }
    }
}
