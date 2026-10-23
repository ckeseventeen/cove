import { useEffect, useState } from "react";
import { Check, CircleAlert, ExternalLink, LoaderCircle, Sparkles } from "lucide-react";
import {
  generateAiSubtitles,
  loadAiKey,
  saveAiKey,
  type AiSubtitleConfig,
  type MediaFile,
  type SubtitleProgress,
} from "../lib/nimbus";
import { listen } from "@tauri-apps/api/event";
import { aiEndpoint, savedKeyOwner } from "../lib/aiSubtitles";
import { isTauri } from "../lib/native";
import { SYSTEM } from "../lib/platform";
import { Popup, Segmented } from "../ui/controls";
import { Sheet } from "../ui/Sheet";

type Provider = AiSubtitleConfig["provider"];
type Mode = AiSubtitleConfig["mode"];
type Scope = AiSubtitleConfig["scope"];

const PROVIDERS: { value: Provider; label: string; model: string; keyUrl?: string; hint: string }[] = [
  { value: "siliconflow", label: "硅基流动", model: "FunAudioLLM/SenseVoiceSmall", keyUrl: "https://cloud.siliconflow.cn/", hint: "国内网络可直接使用" },
  { value: "groq", label: "Groq", model: "whisper-large-v3", keyUrl: "https://console.groq.com/keys", hint: "速度快，提供免费额度" },
  { value: "openai", label: "OpenAI", model: "whisper-1", hint: "官方 Whisper 接口" },
  { value: "custom", label: "自定义", model: "", hint: "兼容 OpenAI 的本地或自建服务" },
];

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Preferences are best effort.
  }
}

export function AiSubtitlesSheet({
  file,
  cached,
  onClose,
  onGenerated,
}: {
  file: MediaFile;
  cached: boolean;
  onClose: () => void;
  onGenerated: (fileId: string, srtPath: string) => void;
}) {
  const [provider, setProvider] = useState<Provider>(() => stored("cove_ai_provider", ["siliconflow", "groq", "openai", "custom"], "siliconflow"));
  // Keys are kept per service, so switching service never sends one service's key to another.
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem("cove_ai_base_url") || "");
  const [model, setModel] = useState(() => localStorage.getItem("cove_ai_model") || "");
  const [mode, setMode] = useState<Mode>(() => stored("cove_ai_mode", ["original", "translate_zh", "bilingual"], "translate_zh"));
  const [scope, setScope] = useState<Scope>("preview");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SubtitleProgress | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keys live in the Keychain; migrate any legacy plaintext copy once.
  useEffect(() => {
    let disposed = false;
    const restore = async () => {
      const legacy = localStorage.getItem("cove_ai_key");
      if (legacy) {
        await saveAiKey(legacy);
        localStorage.removeItem("cove_ai_key");
      }
      const value = legacy || (await loadAiKey());
      const recorded = localStorage.getItem("cove_ai_key_provider");
      const owner = savedKeyOwner(recorded, localStorage.getItem("cove_ai_provider"));
      if (!value || !owner) return;
      if (!recorded) remember("cove_ai_key_provider", owner);
      if (!disposed) setKeys((current) => (current[owner] ? current : { ...current, [owner]: value }));
    };
    void restore().catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<SubtitleProgress>("ai-subtitles-progress", (event) => {
      if (!disposed && event.payload.fileId === file.id) setProgress(event.payload);
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [file.id]);

  const selected = PROVIDERS.find((item) => item.value === provider) ?? PROVIDERS[0];
  const apiKey = keys[provider] ?? "";
  const setApiKey = (value: string) => setKeys((current) => ({ ...current, [provider]: value }));

  const generate = async () => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    setProgress({ fileId: file.id, stage: "starting", percent: 3, message: "正在准备音频…" });
    remember("cove_ai_provider", provider);
    remember("cove_ai_base_url", baseUrl);
    remember("cove_ai_model", model);
    remember("cove_ai_mode", mode);
    try {
      if (apiKey.trim()) {
        await saveAiKey(apiKey);
        remember("cove_ai_key_provider", provider);
      }
      const result = await generateAiSubtitles(file.id, {
        provider,
        apiKey,
        baseUrl: aiEndpoint(provider, baseUrl),
        // Built-in services use their recommended model; only custom endpoints are configurable.
        model: provider === "custom" ? model.trim() || undefined : selected.model,
        mode,
        scope,
      });
      setSuccess(`已生成 ${result.segmentCount} 条字幕${result.applied ? "并加载到当前视频" : "，下次打开该视频时会自动加载"}。`);
      onGenerated(result.fileId, result.srtPath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={busy ? () => undefined : onClose} labelledBy="ai-subtitles-title" width={460} centered dismissOnBackdrop={!busy}>
      <div className="sheet-header">
        <span className="glyph purple">
          <Sparkles size={16} />
        </span>
        <div>
          <h2 className="sheet-title" id="ai-subtitles-title">
            生成 AI 字幕
          </h2>
          <p className="sheet-subtitle">{cached ? "这个视频已有生成的字幕，可以重新生成。" : "识别对白并生成字幕文件。"}</p>
        </div>
      </div>
      <div className="sheet-body">
        <div className="form-grid">
          <label>服务</label>
          <div className="form-inline">
            <Popup<Provider>
              ariaLabel="AI 服务"
              value={provider}
              onChange={(value) => {
                setProvider(value);
                const next = PROVIDERS.find((item) => item.value === value);
                if (next?.model) setModel(next.model);
              }}
              options={PROVIDERS.map((item) => ({ value: item.value, label: item.label }))}
            />
            <span className="secondary form-hint">{selected.hint}</span>
          </div>
          <label htmlFor="ai-key">API 密钥</label>
          <div>
            <input
              id="ai-key"
              className="field"
              type="password"
              value={apiKey}
              placeholder={provider === "groq" ? "gsk_…" : "sk-…"}
              autoComplete="off"
              data-autofocus
              onChange={(event) => setApiKey(event.target.value)}
            />
            {selected.keyUrl && (
              <a className="form-link" href={selected.keyUrl} target="_blank" rel="noreferrer">
                获取 {selected.label} 密钥 <ExternalLink size={11} />
              </a>
            )}
          </div>
          {provider === "custom" && (
            <>
              <label htmlFor="ai-url">接口地址</label>
              <input
                id="ai-url"
                className="field"
                value={baseUrl}
                placeholder="http://127.0.0.1:8000/v1/audio/transcriptions"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              <label htmlFor="ai-model">模型</label>
              <input id="ai-model" className="field" value={model} placeholder="whisper-large-v3" onChange={(event) => setModel(event.target.value)} />
            </>
          )}
          <label>字幕语言</label>
          <Segmented<Mode>
            ariaLabel="字幕语言"
            value={mode}
            onChange={setMode}
            options={[
              { value: "translate_zh", label: "中文" },
              { value: "bilingual", label: "双语" },
              { value: "original", label: "原文" },
            ]}
          />
          <label>范围</label>
          <Segmented<Scope>
            ariaLabel="生成范围"
            value={scope}
            onChange={setScope}
            options={[
              { value: "preview", label: "前 5 分钟" },
              { value: "full", label: "整部影片" },
            ]}
          />
        </div>
        <p className="form-note">密钥保存在 {SYSTEM.systemKeychain}中。生成时会把音轨发送到所选服务，可能产生费用。</p>
        {progress && (
          <div className="ai-progress">
            <div className="progress">
              <span style={{ width: `${Math.max(3, Math.min(100, progress.percent))}%` }} />
            </div>
            <p className="secondary">
              <LoaderCircle className="spin" size={12} /> {progress.message}
            </p>
          </div>
        )}
        {success && (
          <p className="form-success">
            <Check size={14} /> {success}
          </p>
        )}
        {error && (
          <p className="form-error">
            <CircleAlert size={14} /> {error}
          </p>
        )}
      </div>
      <div className="sheet-footer">
        <button className="btn" disabled={busy} onClick={onClose}>
          {success ? "完成" : "取消"}
        </button>
        <button className="btn prominent" disabled={busy || (!apiKey.trim() && provider !== "custom")} onClick={() => void generate()}>
          {busy ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
          {busy ? "正在生成…" : cached ? "重新生成" : "生成"}
        </button>
      </div>
    </Sheet>
  );
}
