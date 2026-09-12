use std::{fs, path::PathBuf, process::Command, time::Duration};

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

fn find_ffmpeg() -> Option<PathBuf> {
    let candidates = [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ];
    for candidate in candidates {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(output) = Command::new("which").arg("ffmpeg").output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
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
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
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

#[tauri::command]
pub async fn ai_subtitles_generate(
    file_id: String,
    config: AiSubtitleConfig,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<SubtitleResult> {
    validate_file_id(&file_id)?;
    let app_handle = window.app_handle().clone();
    let file = state.store.get_media_file(&file_id)?;

    // 1. Determine media source input
    let media_input = if file.account_id == "local" {
        file.remote_path.clone()
    } else {
        state.proxy.create_url(file_id.clone()).await
    };
    if media_input.starts_with('-') {
        return Err(NimbusError::Validation("无效的媒体路径".into()));
    }

    let ffmpeg_bin = find_ffmpeg().ok_or_else(|| {
        NimbusError::Internal(
            "未在系统中找到 ffmpeg 命令，请先安装 ffmpeg（如 brew install ffmpeg）".into(),
        )
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

    emit_progress("extracting", 10, "正在从视频提取音频轨...");

    let temp_audio = std::env::temp_dir().join(format!("cove_audio_{}.mp3", uuid::Uuid::new_v4()));
    let _temp_guard = TempAudio(temp_audio.clone());
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
        "mp3",
    ])
    .arg(&temp_audio);

    let extract_output = tokio::task::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| NimbusError::Internal(format!("音频提取失败：{e}")))?
        .map_err(|e| NimbusError::Internal(format!("音频提取失败：{e}")))?;

    if !extract_output.status.success() || !temp_audio.exists() {
        let err_msg = String::from_utf8_lossy(&extract_output.stderr);
        return Err(NimbusError::Internal(format!("音频提取失败：{err_msg}")));
    }

    emit_progress("transcribing", 40, "音频提取完成，AI 正在识别语音...");

    let metadata = tokio::fs::metadata(&temp_audio)
        .await
        .map_err(|e| NimbusError::Internal(format!("无法获取音频大小：{e}")))?;
    if metadata.len() > 25 * 1024 * 1024 {
        let _ = tokio::fs::remove_file(&temp_audio).await;
        return Err(NimbusError::Validation("音频文件过大，限制 25MB".into()));
    }

    let audio_bytes = tokio::fs::read(&temp_audio)
        .await
        .map_err(|e| NimbusError::Internal(format!("读取音频失败：{e}")))?;
    let _ = tokio::fs::remove_file(&temp_audio).await;

    // 2. Prepare API details
    let (endpoint, model, default_chat_model, chat_endpoint) = match config.provider.as_str() {
        "siliconflow" => (
            config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.siliconflow.cn/v1/audio/transcriptions".into()),
            config
                .model
                .clone()
                .unwrap_or_else(|| "FunAudioLLM/SenseVoiceSmall".into()),
            "Qwen/Qwen2.5-7B-Instruct",
            "https://api.siliconflow.cn/v1/chat/completions",
        ),
        "groq" => (
            config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.groq.com/openai/v1/audio/transcriptions".into()),
            config
                .model
                .clone()
                .unwrap_or_else(|| "whisper-large-v3".into()),
            "llama-3.1-8b-instant",
            "https://api.groq.com/openai/v1/chat/completions",
        ),
        "openai" => (
            config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.openai.com/v1/audio/transcriptions".into()),
            config.model.clone().unwrap_or_else(|| "whisper-1".into()),
            "gpt-4o-mini",
            "https://api.openai.com/v1/chat/completions",
        ),
        _ => (
            config
                .base_url
                .clone()
                .unwrap_or_else(|| "http://127.0.0.1:8000/v1/audio/transcriptions".into()),
            config
                .model
                .clone()
                .unwrap_or_else(|| "whisper-large-v3".into()),
            "default",
            "http://127.0.0.1:8000/v1/chat/completions",
        ),
    };

    let chat_endpoint = if config
        .base_url
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        let mut address = url::Url::parse(&endpoint)?;
        if let Some(base) = address.path().strip_suffix("/audio/transcriptions") {
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
            chat_endpoint.to_owned()
        }
    } else {
        chat_endpoint.to_owned()
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| NimbusError::Internal(e.to_string()))?;

    let file_part = Part::bytes(audio_bytes)
        .file_name("audio.mp3")
        .mime_str("audio/mpeg")
        .map_err(|e| NimbusError::Internal(e.to_string()))?;

    let mut form = Form::new()
        .part("file", file_part)
        .text("model", model)
        .text("response_format", "verbose_json");

    if let Some(lang) = config
        .language
        .as_deref()
        .filter(|l| *l != "auto" && !l.is_empty())
    {
        form = form.text("language", lang.to_string());
    }

    let mut request = client.post(&endpoint).multipart(form);
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

    let json_resp: Value = response
        .json()
        .await
        .map_err(|e| NimbusError::Internal(format!("解析 AI 转写结果失败：{e}")))?;

    // 3. Parse segments
    let mut segments = Vec::new();
    if let Some(arr) = json_resp.get("segments").and_then(|v| v.as_array()) {
        for item in arr {
            let start = item.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let end = item
                .get("end")
                .and_then(|v| v.as_f64())
                .unwrap_or(start + 2.0);
            let text = item
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if !text.is_empty() {
                segments.push(SubtitleSegment {
                    start,
                    end,
                    text,
                    translation: None,
                });
            }
        }
    } else if json_resp.get("text").is_some() {
        return Err(NimbusError::Validation(
            "转写服务未返回时间戳，无法生成同步字幕，请选择支持分段时间轴的模型".into(),
        ));
    }

    if segments.is_empty() {
        return Err(NimbusError::Internal(
            "未能从音频中识别到有效字幕文本".into(),
        ));
    }

    // 4. Optional Translation via LLM if requested and not Chinese
    if (config.mode == "translate_zh" || config.mode == "bilingual")
        && !config.api_key.trim().is_empty()
    {
        emit_progress("translating", 75, "正在进行智能中文翻译...");

        // Batch translate segments in chunks of 30
        for chunk in segments.chunks_mut(30) {
            let combined: Vec<String> = chunk.iter().map(|s| s.text.clone()).collect();
            let prompt = format!(
                "请将以下影视台词逐行翻译成自然流畅的简体中文。请务必保持行数完全一致（共 {} 行），每行对应翻译结果，不要输出任何多余解释：\n\n{}",
                combined.len(),
                combined.join("\n")
            );

            let body = serde_json::json!({
                "model": default_chat_model,
                "messages": [
                    { "role": "system", "content": "你是一位专业的电影影视字幕翻译员。请逐行翻译用户的台词，保持行数严格一对一，直接输出译文。" },
                    { "role": "user", "content": prompt }
                ],
                "temperature": 0.3
            });

            if let Ok(chat_res) = client
                .post(&chat_endpoint)
                .bearer_auth(config.api_key.trim())
                .json(&body)
                .send()
                .await
            {
                if chat_res.status().is_success() {
                    if let Ok(chat_json) = chat_res.json::<Value>().await {
                        if let Some(content) = chat_json
                            .pointer("/choices/0/message/content")
                            .and_then(|v| v.as_str())
                        {
                            let trans_lines: Vec<&str> = content
                                .lines()
                                .map(|l| l.trim())
                                .filter(|l| !l.is_empty())
                                .collect();
                            if trans_lines.len() == chunk.len() {
                                for (seg, trans) in chunk.iter_mut().zip(trans_lines) {
                                    seg.translation = Some(trans.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if matches!(config.mode.as_str(), "translate_zh" | "bilingual")
        && segments.iter().any(|segment| segment.translation.is_none())
    {
        return Err(NimbusError::Validation(
            "字幕翻译未全部完成，原有字幕未覆盖，请检查翻译服务后重试".into(),
        ));
    }

    // 5. Generate SRT and Save
    emit_progress("saving", 90, "正在构建时间轴并装载字幕...");

    let srt_content = build_srt_content(&segments, &config.mode);
    validate_file_id(&file_id)?;
    let srt_path = get_subtitles_dir().join(format!("{}.srt", file_id));
    tokio::fs::write(&srt_path, srt_content)
        .await
        .map_err(|e| NimbusError::Internal(format!("写入字幕文件失败：{e}")))?;

    // 6. Mount onto player
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
struct TempAudio(PathBuf);
impl Drop for TempAudio {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
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
        fs::write(&path, b"partial").unwrap();
        {
            let _guard = TempAudio(path.clone());
        }
        assert!(!path.exists());
    }
}
