use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager, State};

use crate::{
    error::{NimbusError, Result},
    AppState,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSubtitleConfig {
    pub provider: String, // "siliconflow" | "groq" | "openai" | "custom"
    pub api_key: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub mode: String,             // "original" | "translate_zh" | "bilingual"
    pub scope: String,            // "full" | "preview"
    pub language: Option<String>, // "auto" | "zh" | "en" | "ja" | "ko" etc.
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub translation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleProgress {
    pub file_id: String,
    pub stage: String,
    pub percent: u32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleResult {
    pub file_id: String,
    pub srt_path: String,
    pub segment_count: usize,
    pub applied: bool,
}

/// Audio is sent in chunks of this many seconds: about 3.6 MB each at 48 kb/s, well under
/// the 25 MB upload limit of the hosted services, so a whole film of any length fits.
const CHUNK_SECONDS: &str = "600";
const UPLOAD_LIMIT: u64 = 25 * 1024 * 1024;
/// A sliver left over at the very end is skipped; services reject clips this short.
const MIN_CHUNK_SECONDS: f64 = 1.0;
const TRANSLATION_BATCH: usize = 30;

struct Service {
    transcription: String,
    model: String,
    chat: String,
    chat_model: &'static str,
    /// A self-hosted service may have no chat model at the derived address.
    custom: bool,
}

/// Built-in services always use their own addresses. Only the custom service takes the
/// configured endpoint, so a leftover custom address never receives a built-in service's key.
fn resolve_service(config: &AiSubtitleConfig) -> Result<Service> {
    let model = |fallback: &str| {
        config
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback)
            .to_owned()
    };
    let builtin = |transcription: &str, model: String, chat: &str, chat_model| Service {
        transcription: transcription.to_owned(),
        model,
        chat: chat.to_owned(),
        chat_model,
        custom: false,
    };
    Ok(match config.provider.as_str() {
        "siliconflow" => builtin(
            "https://api.siliconflow.cn/v1/audio/transcriptions",
            model("FunAudioLLM/SenseVoiceSmall"),
            "https://api.siliconflow.cn/v1/chat/completions",
            "Qwen/Qwen2.5-7B-Instruct",
        ),
        "groq" => builtin(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            model("whisper-large-v3"),
            "https://api.groq.com/openai/v1/chat/completions",
            "llama-3.1-8b-instant",
        ),
        "openai" => builtin(
            "https://api.openai.com/v1/audio/transcriptions",
            model("whisper-1"),
            "https://api.openai.com/v1/chat/completions",
            "gpt-4o-mini",
        ),
        _ => {
            let transcription = config
                .base_url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("http://127.0.0.1:8000/v1/audio/transcriptions");
            let mut address = url::Url::parse(transcription)?;
            let chat = if let Some(base) = address.path().strip_suffix("/audio/transcriptions") {
                let path = format!("{base}/chat/completions");
                address.set_path(&path);
                address.set_query(None);
                address.set_fragment(None);
                address.to_string()
            } else if config.mode != "original" {
                return Err(NimbusError::Validation(
                    "自定义翻译需要兼容的 /audio/transcriptions 接口地址".into(),
                ));
            } else {
                String::new()
            };
            Service {
                transcription: transcription.to_owned(),
                model: model("whisper-large-v3"),
                chat,
                chat_model: "default",
                custom: true,
            }
        }
    })
}

/// Chunks listed by ffmpeg's `-segment_list_type csv` (`name,start,end` per line), each with
/// its start in the whole audio.
fn audio_chunks(list: &str, dir: &Path) -> Vec<(PathBuf, f64)> {
    list.lines()
        .filter_map(|line| {
            let mut fields = line.trim().rsplitn(3, ',');
            let end = fields.next()?.parse::<f64>().ok()?;
            let start = fields.next()?.parse::<f64>().ok()?;
            let name = Path::new(fields.next()?.trim_matches('"')).file_name()?;
            Some((dir.join(name), start, end))
        })
        .enumerate()
        .filter(|(index, (_, start, end))| *index == 0 || end - start >= MIN_CHUNK_SECONDS)
        .map(|(_, (path, start, _))| (path, start))
        .collect()
}

/// The timed segments of one chunk, moved to the chunk's place in the whole audio.
fn chunk_segments(response: &Value, offset: f64) -> Result<Vec<SubtitleSegment>> {
    let Some(items) = response.get("segments").and_then(Value::as_array) else {
        // Silence may come back without segments; spoken text without them has no timing.
        if response
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
        {
            return Err(NimbusError::Validation(
                "转写服务未返回时间戳，无法生成同步字幕，请选择支持分段时间轴的模型".into(),
            ));
        }
        return Ok(Vec::new());
    };
    Ok(items
        .iter()
        .filter_map(|item| {
            let text = item.get("text").and_then(Value::as_str)?.trim();
            if text.is_empty() {
                return None;
            }
            let start = item.get("start").and_then(Value::as_f64).unwrap_or(0.0);
            let end = item
                .get("end")
                .and_then(Value::as_f64)
                .unwrap_or(start + 2.0);
            Some(SubtitleSegment {
                start: offset + start,
                end: offset + end,
                text: text.to_owned(),
                translation: None,
            })
        })
        .collect())
}

async fn transcribe(
    client: &reqwest::Client,
    service: &Service,
    config: &AiSubtitleConfig,
    audio: Vec<u8>,
) -> Result<Value> {
    let file_part = Part::bytes(audio)
        .file_name("audio.mp3")
        .mime_str("audio/mpeg")
        .map_err(|e| NimbusError::Internal(e.to_string()))?;

    let mut form = Form::new()
        .part("file", file_part)
        .text("model", service.model.clone())
        .text("response_format", "verbose_json");

    if let Some(lang) = config
        .language
        .as_deref()
        .filter(|l| *l != "auto" && !l.is_empty())
    {
        form = form.text("language", lang.to_string());
    }

    let mut request = client.post(&service.transcription).multipart(form);
    if !config.api_key.trim().is_empty() {
        request = request.bearer_auth(config.api_key.trim());
    }

    let response = request
        .send()
        .await
        .map_err(|e| NimbusError::Internal(format!("调用 AI 转写服务失败：{e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let err_text = response.text().await.unwrap_or_default();
        return Err(NimbusError::Internal(format!(
            "AI 转写接口返回错误（HTTP {status}）：{err_text}"
        )));
    }

    response
        .json()
        .await
        .map_err(|e| NimbusError::Internal(format!("解析 AI 转写结果失败：{e}")))
}

/// One batch of lines translated in order, or why it could not be. A keyless custom
/// service is called without authorization, as for transcription.
async fn translate_batch(
    client: &reqwest::Client,
    service: &Service,
    api_key: &str,
    lines: &[String],
) -> std::result::Result<Vec<String>, String> {
    let prompt = format!(
        "请将以下影视台词逐行翻译成自然流畅的简体中文。请务必保持行数完全一致（共 {} 行），每行对应翻译结果，不要输出任何多余解释：\n\n{}",
        lines.len(),
        lines.join("\n")
    );
    let body = serde_json::json!({
        "model": service.chat_model,
        "messages": [
            { "role": "system", "content": "你是一位专业的电影影视字幕翻译员。请逐行翻译用户的台词，保持行数严格一对一，直接输出译文。" },
            { "role": "user", "content": prompt }
        ],
        "temperature": 0.3
    });
    let mut request = client.post(&service.chat).json(&body);
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let json: Value = response.json().await.map_err(|e| e.to_string())?;
    let translated: Vec<String> = json
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    if translated.len() != lines.len() {
        return Err("译文行数与原文不一致".into());
    }
    Ok(translated)
}

/// Run a command-line tool without flashing a console window on Windows.
fn quiet(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn find_ffmpeg() -> Option<PathBuf> {
    // On Windows, an ffmpeg.exe placed beside Cove.exe comes first.
    let beside = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.join("ffmpeg.exe")));
    let candidates = if cfg!(windows) {
        vec![beside]
    } else {
        ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].map(|path| Some(PathBuf::from(path))).to_vec()
    };
    for candidate in candidates.into_iter().flatten() {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let lookup = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = quiet(Command::new(lookup).arg("ffmpeg")).output() {
        if output.status.success() {
            // `where` lists every match, one per line.
            let path_str = String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or_default().trim().to_string();
            if !path_str.is_empty() {
                return Some(PathBuf::from(path_str));
            }
        }
    }
    None
}

fn format_srt_timestamp(seconds: f64) -> String {
    let millis = if seconds.is_finite() {
        (seconds.max(0.0) * 1000.0).round() as u64
    } else {
        0
    };
    format!(
        "{:02}:{:02}:{:02},{:03}",
        millis / 3_600_000,
        millis / 60_000 % 60,
        millis / 1000 % 60,
        millis % 1000
    )
}

fn build_srt_content(segments: &[SubtitleSegment], mode: &str) -> String {
    let mut srt = String::new();
    for (i, seg) in segments.iter().enumerate() {
        let text = seg.text.trim();
        if text.is_empty() {
            continue;
        }
        srt.push_str(&(i + 1).to_string());
        srt.push('\n');
        srt.push_str(&format!(
            "{} --> {}\n",
            format_srt_timestamp(seg.start),
            format_srt_timestamp(seg.end)
        ));

        if mode == "bilingual" {
            if let Some(trans) = seg.translation.as_ref().filter(|t| !t.trim().is_empty()) {
                srt.push_str(trans.trim());
                srt.push('\n');
            }
            srt.push_str(text);
            srt.push_str("\n\n");
        } else if mode == "translate_zh" {
            if let Some(trans) = seg.translation.as_ref().filter(|t| !t.trim().is_empty()) {
                srt.push_str(trans.trim());
                srt.push_str("\n\n");
            } else {
                srt.push_str(text);
                srt.push_str("\n\n");
            }
        } else {
            srt.push_str(text);
            srt.push_str("\n\n");
        }
    }
    srt
}

pub fn get_subtitles_dir() -> PathBuf {
    // Windows names the home folder USERPROFILE.
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_else(|| ".".into());
    let dir = PathBuf::from(home).join(".cove").join("subtitles");
    let _ = fs::create_dir_all(&dir);
    dir
}

#[tauri::command]
pub async fn ai_subtitles_cached(file_id: String) -> Result<Option<String>> {
    validate_file_id(&file_id)?;
    let srt_path = get_subtitles_dir().join(format!("{}.srt", file_id));
    if srt_path.is_file() {
        Ok(Some(srt_path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

/// Loading a file drops its external subtitle tracks, so subtitles generated earlier are
/// attached again each time their video opens.
pub(crate) async fn restore_saved(app: &tauri::AppHandle, state: &AppState, file_id: &str) {
    if validate_file_id(file_id).is_err() {
        return;
    }
    let srt_path = get_subtitles_dir().join(format!("{file_id}.srt"));
    if !srt_path.is_file() {
        return;
    }
    let path = srt_path.to_string_lossy();
    if let Ok(true) = state.player.add_subtitle_for_file(file_id, &path).await {
        let snapshot = state.player.status().await;
        let _ = app.emit("nimbus-player-state", &snapshot);
    }
}

#[tauri::command]
pub async fn ai_subtitles_generate(
    file_id: String,
    config: AiSubtitleConfig,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<SubtitleResult> {
    validate_file_id(&file_id)?;
    // Settings problems surface before any audio is read.
    let service = resolve_service(&config)?;
    let app_handle = window.app_handle().clone();
    let file = state.store.get_media_file(&file_id)?;

    // 1. Determine media source input
    let provider = state.store.get_account(&file.account_id)?.account.provider;
    let media_input = if file.account_id == "local" {
        crate::paths::native(&file.remote_path).to_string_lossy().into_owned()
    } else if provider == "smb" {
        crate::smb::local_file(&state, &file.account_id, &file.remote_path).await?.to_string_lossy().into_owned()
    } else {
        state.proxy.create_url(file_id.clone()).await
    };
    if media_input.starts_with('-') {
        return Err(NimbusError::Validation("无效的媒体路径".into()));
    }

    let ffmpeg_bin = find_ffmpeg().ok_or_else(|| {
        NimbusError::Internal(if cfg!(windows) {
            "未找到 ffmpeg，请安装 ffmpeg（如 winget install ffmpeg），或把 ffmpeg.exe 放在 Cove.exe 旁边".into()
        } else {
            "未在系统中找到 ffmpeg 命令，请先安装 ffmpeg（如 brew install ffmpeg）".into()
        })
    })?;

    let emit_progress = |stage: &str, percent: u32, message: &str| {
        let _ = app_handle.emit(
            "ai-subtitles-progress",
            SubtitleProgress {
                file_id: file_id.clone(),
                stage: stage.into(),
                percent,
                message: message.into(),
            },
        );
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| NimbusError::Internal(e.to_string()))?;
    let translate = matches!(config.mode.as_str(), "translate_zh" | "bilingual");

    // Ask a custom service to translate one line first, so a missing chat model is
    // reported now rather than after the whole film has been read and transcribed.
    if translate && service.custom {
        emit_progress("checking", 5, "正在检查翻译服务...");
        let lines = ["Hello.".to_owned()];
        let probe = translate_batch(&client, &service, config.api_key.trim(), &lines).await;
        if let Err(reason) = probe {
            return Err(NimbusError::Validation(format!(
                "自定义服务无法翻译（{reason}），请选择“原文”或检查服务后重试"
            )));
        }
    }

    emit_progress("extracting", 10, "正在从视频提取音频轨...");

    // One pass over the video writes the audio in chunks, so cloud files are read only once.
    let work_dir = std::env::temp_dir().join(format!("cove_audio_{}", uuid::Uuid::new_v4()));
    let _temp_guard = TempAudio(work_dir.clone());
    tokio::fs::create_dir_all(&work_dir)
        .await
        .map_err(|e| NimbusError::Internal(format!("音频提取失败：{e}")))?;
    let list_path = work_dir.join("chunks.csv");
    let mut cmd = Command::new(&ffmpeg_bin);
    cmd.arg("-y");

    if config.scope == "preview" {
        cmd.args(["-t", "300"]);
    }

    cmd.args([
        "-i",
        &media_input,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "48k",
        "-f",
        "segment",
        "-segment_format",
        "mp3",
        "-segment_time",
        CHUNK_SECONDS,
        "-reset_timestamps",
        "1",
        "-segment_list_type",
        "csv",
        "-segment_list",
    ])
    .arg(&list_path)
    .arg(work_dir.join("chunk_%04d.mp3"));

    let extract_output = tokio::task::spawn_blocking(move || quiet(&mut cmd).output())
        .await
        .map_err(|e| NimbusError::Internal(format!("音频提取失败：{e}")))?
        .map_err(|e| NimbusError::Internal(format!("音频提取失败：{e}")))?;

    let chunks = tokio::fs::read_to_string(&list_path)
        .await
        .map(|list| audio_chunks(&list, &work_dir))
        .unwrap_or_default();
    if !extract_output.status.success() || chunks.is_empty() {
        let err_msg = String::from_utf8_lossy(&extract_output.stderr);
        return Err(NimbusError::Internal(format!("音频提取失败：{err_msg}")));
    }

    // 2. Transcribe chunk by chunk, placing each chunk's segments on the video's timeline
    let mut segments = Vec::new();
    for (index, (path, start)) in chunks.iter().enumerate() {
        let message = if chunks.len() > 1 {
            format!("AI 正在识别语音（{}/{}）...", index + 1, chunks.len())
        } else {
            "音频提取完成，AI 正在识别语音...".to_owned()
        };
        emit_progress(
            "transcribing",
            40 + (35 * index / chunks.len()) as u32,
            &message,
        );
        let audio = tokio::fs::read(path)
            .await
            .map_err(|e| NimbusError::Internal(format!("读取音频失败：{e}")))?;
        if audio.len() as u64 > UPLOAD_LIMIT {
            return Err(NimbusError::Validation("音频文件过大，限制 25MB".into()));
        }
        let response = transcribe(&client, &service, &config, audio).await?;
        segments.extend(chunk_segments(&response, *start)?);
    }

    if segments.is_empty() {
        return Err(NimbusError::Internal(
            "未能从音频中识别到有效字幕文本".into(),
        ));
    }

    // 3. Translate with the service's chat model when a Chinese track is requested
    if translate {
        let api_key = config.api_key.trim();
        let batches = segments.len().div_ceil(TRANSLATION_BATCH);
        for (index, chunk) in segments.chunks_mut(TRANSLATION_BATCH).enumerate() {
            let message = if batches > 1 {
                format!("正在进行智能中文翻译（{}/{}）...", index + 1, batches)
            } else {
                "正在进行智能中文翻译...".to_owned()
            };
            emit_progress("translating", 75 + (15 * index / batches) as u32, &message);
            let lines: Vec<String> = chunk.iter().map(|s| s.text.clone()).collect();
            // One retry: a model now and then merges or splits a line.
            let mut translated = translate_batch(&client, &service, api_key, &lines).await;
            if translated.is_err() {
                translated = translate_batch(&client, &service, api_key, &lines).await;
            }
            match translated {
                Ok(translated) => {
                    for (seg, trans) in chunk.iter_mut().zip(translated) {
                        seg.translation = Some(trans);
                    }
                }
                Err(reason) => {
                    return Err(NimbusError::Validation(format!(
                        "字幕翻译未全部完成（{reason}），原有字幕未覆盖，请检查翻译服务后重试"
                    )));
                }
            }
        }
    }

    // 4. Generate SRT and Save
    emit_progress("saving", 90, "正在构建时间轴并装载字幕...");

    let srt_content = build_srt_content(&segments, &config.mode);
    validate_file_id(&file_id)?;
    let srt_path = get_subtitles_dir().join(format!("{}.srt", file_id));
    tokio::fs::write(&srt_path, srt_content)
        .await
        .map_err(|e| NimbusError::Internal(format!("写入字幕文件失败：{e}")))?;

    // 5. Mount onto player
    let srt_str = srt_path.to_string_lossy().to_string();
    let applied = state
        .player
        .add_subtitle_for_file(&file_id, &srt_str)
        .await?;
    let snapshot = state.player.status().await;
    let _ = app_handle.emit("nimbus-player-state", &snapshot);

    emit_progress(
        "completed",
        100,
        if applied {
            "AI 字幕已生成并加载"
        } else {
            "AI 字幕已保存，当前播放文件已切换"
        },
    );

    Ok(SubtitleResult {
        file_id,
        srt_path: srt_str,
        segment_count: segments.len(),
        applied,
    })
}

fn validate_file_id(id: &str) -> Result<()> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(NimbusError::Validation("字幕文件标识无效".into()));
    }
    Ok(())
}
/// The working directory holding the extracted audio chunks.
struct TempAudio(PathBuf);
impl Drop for TempAudio {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[cfg(test)]
mod regression_tests {
    use super::*;
    #[test]
    fn timestamp_rounding_carries_into_next_minute() {
        assert_eq!(format_srt_timestamp(59.9999), "00:01:00,000");
        assert_eq!(format_srt_timestamp(-2.0), "00:00:00,000");
    }
    #[test]
    fn cached_subtitle_id_cannot_escape_directory() {
        for id in ["", "../secret", "/tmp/file", "a/b"] {
            assert!(validate_file_id(id).is_err());
        }
        assert!(validate_file_id("file-123_abc").is_ok());
    }
    #[test]
    fn failed_extraction_cleans_temporary_audio() {
        let path = std::env::temp_dir().join(format!("cove-cleanup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("chunk_0000.mp3"), b"partial").unwrap();
        {
            let _guard = TempAudio(path.clone());
        }
        assert!(!path.exists());
    }

    fn config(provider: &str, base_url: Option<&str>, mode: &str) -> AiSubtitleConfig {
        AiSubtitleConfig {
            provider: provider.into(),
            api_key: "sk-builtin".into(),
            base_url: base_url.map(Into::into),
            model: None,
            mode: mode.into(),
            scope: "full".into(),
            language: None,
        }
    }

    #[test]
    fn leftover_custom_address_never_redirects_a_builtin_service() {
        let stale = Some("http://192.168.1.10:8000/v1/audio/transcriptions");
        for (provider, host) in [
            ("siliconflow", "api.siliconflow.cn"),
            ("groq", "api.groq.com"),
            ("openai", "api.openai.com"),
        ] {
            let service = resolve_service(&config(provider, stale, "translate_zh")).unwrap();
            assert!(service
                .transcription
                .starts_with(&format!("https://{host}/")));
            assert!(service.chat.starts_with(&format!("https://{host}/")));
            assert!(!service.custom);
        }
    }

    #[test]
    fn custom_address_also_serves_translation() {
        let service = resolve_service(&config(
            "custom",
            Some(" http://192.168.1.10:8000/v1/audio/transcriptions?x=1 "),
            "translate_zh",
        ))
        .unwrap();
        assert_eq!(
            service.transcription,
            "http://192.168.1.10:8000/v1/audio/transcriptions?x=1"
        );
        assert_eq!(service.chat, "http://192.168.1.10:8000/v1/chat/completions");
        assert!(service.custom);
        let local = resolve_service(&config("custom", Some(""), "bilingual")).unwrap();
        assert_eq!(local.chat, "http://127.0.0.1:8000/v1/chat/completions");
        // Translation needs an address the chat endpoint can be derived from.
        let other = "http://192.168.1.10:9000/asr";
        assert!(resolve_service(&config("custom", Some(other), "translate_zh")).is_err());
        assert!(resolve_service(&config("custom", Some(other), "original")).is_ok());
    }

    #[tokio::test]
    async fn keyless_custom_service_translates_and_a_missing_chat_model_is_reported() {
        use axum::{http::HeaderMap, routing::post, Json, Router};
        async fn chat(headers: HeaderMap) -> Json<Value> {
            let reply = if headers.contains_key("authorization") {
                "带密钥"
            } else {
                "你好。"
            };
            Json(serde_json::json!({ "choices": [{ "message": { "content": reply } }] }))
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/v1/chat/completions", post(chat));
        tokio::spawn(async move { axum::serve(listener, app).await });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let lines = ["Hello.".to_owned()];

        let address = format!("http://127.0.0.1:{port}/v1/audio/transcriptions");
        let service = resolve_service(&config("custom", Some(&address), "translate_zh")).unwrap();
        let keyless = translate_batch(&client, &service, "", &lines).await;
        assert_eq!(keyless, Ok(vec!["你好。".to_owned()]));
        let keyed = translate_batch(&client, &service, "sk-local", &lines).await;
        assert_eq!(keyed, Ok(vec!["带密钥".to_owned()]));

        // A transcription-only server: the check before extraction fails with the reason.
        let address = format!("http://127.0.0.1:{port}/asr/v1/audio/transcriptions");
        let service = resolve_service(&config("custom", Some(&address), "bilingual")).unwrap();
        let missing = translate_batch(&client, &service, "", &lines).await;
        assert!(missing.unwrap_err().contains("404"));
    }

    #[test]
    fn chunks_keep_their_place_in_the_film() {
        let dir = Path::new("/tmp/work");
        let list = "chunk_0000.mp3,0.000000,600.003813\n\"../chunk_0001.mp3\",600.003813,1200.007812\nchunk_0002.mp3,1200.007812,1200.040000\n";
        let chunks = audio_chunks(list, dir);
        // Names stay inside the work directory; the 30 ms tail is too short for any service.
        assert_eq!(
            chunks,
            vec![
                (dir.join("chunk_0000.mp3"), 0.0),
                (dir.join("chunk_0001.mp3"), 600.003813),
            ]
        );
        let short = audio_chunks("chunk_0000.mp3,0.000000,0.500000\n", dir);
        assert_eq!(short, vec![(dir.join("chunk_0000.mp3"), 0.0)]);
        assert!(audio_chunks("", dir).is_empty());

        let response = serde_json::json!({
            "text": "hello there",
            "segments": [
                { "start": 1.5, "end": 3.0, "text": " hello " },
                { "start": 4.0, "end": 5.0, "text": "  " },
                { "start": 6.0, "text": "there" }
            ]
        });
        let segments = chunk_segments(&response, 600.0).unwrap();
        let timing: Vec<_> = segments
            .iter()
            .map(|s| (s.start, s.end, s.text.as_str()))
            .collect();
        assert_eq!(
            timing,
            vec![(601.5, 603.0, "hello"), (606.0, 608.0, "there")]
        );
    }

    #[test]
    fn silent_chunk_is_empty_but_untimed_speech_is_an_error() {
        assert!(chunk_segments(&serde_json::json!({ "text": " " }), 0.0)
            .unwrap()
            .is_empty());
        assert!(chunk_segments(&serde_json::json!({ "text": "hi" }), 0.0).is_err());
    }
}
