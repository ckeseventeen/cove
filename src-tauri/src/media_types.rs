/// Unified media file type classification used across all storage providers.

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "avi", "wmv", "flv", "webm", "ts", "m2ts", "rmvb", "rm", "mpg",
    "mpeg", "vob",
];

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "flac", "wav", "aac", "ogg", "opus", "wma", "ape", "aiff",
];

/// Check if a filename has a recognized video extension.
pub fn is_video(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| VIDEO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Check if a filename has a recognized audio extension.
pub fn is_audio(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Check if a filename is any recognized media type.
pub fn is_media(name: &str) -> bool {
    is_video(name) || is_audio(name)
}

/// Classify a media file as "movie" (video) or "music" (audio).
pub fn media_kind(name: &str) -> Option<&'static str> {
    if is_video(name) {
        Some("movie")
    } else if is_audio(name) {
        Some("music")
    } else {
        None
    }
}
