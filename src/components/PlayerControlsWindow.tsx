import { loadAiKey, saveAiKey } from "../lib/nimbus";
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  AudioLines,
  Captions,
  Check,
  ExternalLink,
  Film,
  List,
  LoaderCircle,
  Maximize,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import {
  buildMovieWorks,
  cleanWorkTitle,
  episodeLabel,
  episodeOf,
  formatTime,
  seasonOf,
  uniqueEpisodes,
  type MediaWork,
} from "../lib/media";
import {
  controlPlayer,
  generateAiSubtitles,
  getCachedAiSubtitles,
  getCurrentPlayerFile,
  getPlayerPlaylist,
  getPlayerStatus,
  listMediaFiles,
  openNativePlayer,
  subscribePlayer,
  type MediaFile,
  type PlayerStatus,
  type SubtitleProgress,
} from "../lib/nimbus";

export function PlayerControlsWindow() {
  const [current, setCurrent] = useState<MediaFile | null>(null);
  const currentId = useRef<string | null>(null);
  currentId.current = current?.id ?? null;
  const [allFiles, setAllFiles] = useState<MediaFile[]>([]);
  const [playlist, setPlaylist] = useState<MediaFile[]>([]);
  const [status, setStatus] = useState<PlayerStatus>({
    running: false,
    paused: false,
    eofReached: false,
    position: 0,
    duration: 0,
    speed: 1,
    volume: 100,
    tracks: [],
  });

  const [localVolume, setLocalVolume] = useState(100);
  const draggingVolume = useRef(false);
  useEffect(() => {
    if (!draggingVolume.current) setLocalVolume(status.volume);
  }, [status.volume]);

  const [localPosition, setLocalPosition] = useState(0);
  const draggingProgress = useRef(false);
  useEffect(() => {
    if (!draggingProgress.current) setLocalPosition(status.position);
  }, [status.position]);

  const [visible, setVisible] = useState(true);
  const [episodeDrawer, setEpisodeDrawer] = useState(false);
  const [drawerSeason, setDrawerSeason] = useState(1);
  const hideTimer = useRef<number>();
  const [error, setError] = useState<string | null>(null);
  const switchRequest = useRef(0);
  const activeEpisode = useRef<HTMLButtonElement>(null);

  // AI Subtitles state
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiProvider, setAiProvider] = useState<"siliconflow" | "groq" | "openai" | "custom">(() => {
    const stored = localStorage.getItem("cove_ai_provider");
    return stored === "siliconflow" || stored === "groq" || stored === "openai" || stored === "custom"
      ? (stored as any)
      : "siliconflow";
  });
  const [aiKey, setAiKey] = useState("");
  useEffect(() => {
    let disposed = false;
    const legacy = localStorage.getItem("cove_ai_key");
    const restore = async () => {
      if (legacy) { await saveAiKey(legacy); localStorage.removeItem("cove_ai_key"); }
      const stored = legacy || await loadAiKey();
      if (!disposed && stored) setAiKey(current => current || stored);
    };
    void restore().catch(() => undefined);
    return () => { disposed = true; };
  }, []);
  const [aiBaseUrl, setAiBaseUrl] = useState(() => localStorage.getItem("cove_ai_base_url") || "");
  const [aiModel, setAiModel] = useState(() => localStorage.getItem("cove_ai_model") || "");
  const [aiMode, setAiMode] = useState<"original" | "translate_zh" | "bilingual">(() => {
    const stored = localStorage.getItem("cove_ai_mode");
    return stored === "original" || stored === "translate_zh" || stored === "bilingual"
      ? (stored as any)
      : "translate_zh";
  });
  const [aiScope, setAiScope] = useState<"full" | "preview">("preview");
  const [aiLang, setAiLang] = useState("auto");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiProgress, setAiProgress] = useState<SubtitleProgress | null>(null);
  const [aiSuccessMsg, setAiSuccessMsg] = useState<string | null>(null);
  const [aiErrorMsg, setAiErrorMsg] = useState<string | null>(null);
  const [cachedSrt, setCachedSrt] = useState<string | null>(null);

  useEffect(() => {
    let activeId: string | null | undefined;
    let disposed = false;
    const off = subscribePlayer((next) => {
      setStatus(next);
      if (next.fileId === activeId) return;
      activeId = next.fileId;
      if (!next.fileId) {
        setCurrent(null);
        return;
      }
      const id = next.fileId;
      void getCurrentPlayerFile().then((file) => {
        if (!disposed && activeId === id) setCurrent(file);
      });
    });
    return () => {
      disposed = true;
      off();
    };
  }, []);

  useEffect(() => {
    if (!current) return;
    void listMediaFiles().then(setAllFiles);
    void getPlayerPlaylist().then(setPlaylist);
    const id = current.id;
    setCachedSrt(null);
    void getCachedAiSubtitles(id).then(path => { if (currentId.current === id) setCachedSrt(path); }).catch(() => undefined);
  }, [current?.id]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<SubtitleProgress>("ai-subtitles-progress", (event) => {
      if (!disposed && event.payload.fileId === current?.id) {
        setAiProgress(event.payload);
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [current?.id]);

  useEffect(() => {
    const reveal = () => {
      setVisible(true);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (!episodeDrawer && !aiModalOpen) {
        hideTimer.current = window.setTimeout(() => setVisible(false), 3200);
      }
    };
    reveal();
    window.addEventListener("mousemove", reveal);
    window.addEventListener("pointerdown", reveal);
    window.addEventListener("keydown", reveal);
    return () => {
      window.removeEventListener("mousemove", reveal);
      window.removeEventListener("pointerdown", reveal);
      window.removeEventListener("keydown", reveal);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [episodeDrawer, aiModalOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      switch (event.code) {
        case "Space":
          event.preventDefault();
          void controlPlayer("play_pause");
          break;
        case "ArrowLeft":
          event.preventDefault();
          void controlPlayer("seek", -5);
          break;
        case "ArrowRight":
          event.preventDefault();
          void controlPlayer("seek", 5);
          break;
        case "ArrowUp":
          event.preventDefault();
          void controlPlayer("volume", Math.min(100, Math.round(status.volume + 5)));
          break;
        case "ArrowDown":
          event.preventDefault();
          void controlPlayer("volume", Math.max(0, Math.round(status.volume - 5)));
          break;
        case "KeyM":
          event.preventDefault();
          void controlPlayer("volume", status.volume > 0 ? 0 : 100);
          break;
        case "KeyF":
          event.preventDefault();
          void controlPlayer("fullscreen");
          break;
        case "Escape":
          event.preventDefault();
          if (aiModalOpen) {
            setAiModalOpen(false);
          } else if (episodeDrawer) {
            setEpisodeDrawer(false);
          } else {
            void controlPlayer("stop");
          }
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [episodeDrawer, aiModalOpen, status.volume]);

  // Queue resolution: prioritize folder playlist if multi-file, otherwise media works
  const queue = useMemo(() => {
    if (!current) return [];
    if (playlist.length > 1 && playlist.some((f) => f.id === current.id)) {
      return playlist;
    }
    const work = buildMovieWorks(allFiles.filter((file) => file.mediaKind === "movie")).find((work) =>
      work.files.some((file) => file.id === current.id)
    );
    if (!work?.isSeries) {
      if (playlist.length > 0) return playlist;
      return [current];
    }
    return uniqueEpisodes(work.files).map((file) =>
      seasonOf(file) === seasonOf(current) && episodeOf(file) === episodeOf(current) ? current : file
    );
  }, [allFiles, current, playlist]);

  const seasons = useMemo(() => [...new Set(queue.map(seasonOf))].sort((a, b) => a - b), [queue]);

  useEffect(() => {
    if (current && seasons.length) setDrawerSeason(seasonOf(current));
  }, [current?.id, seasons.join(",")]);

  useEffect(() => {
    activeEpisode.current?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  }, [current?.id, episodeDrawer, queue.length]);

  const index = queue.findIndex((file) => file.id === current?.id);

  const switchEpisode = async (file: MediaFile) => {
    setEpisodeDrawer(false);
    const request = ++switchRequest.current;
    setError(null);
    try {
      await openNativePlayer(file.id);
      const next = await getPlayerStatus();
      if (request === switchRequest.current && next.fileId === file.id) {
        setCurrent(file);
        setStatus(next);
      }
    } catch (cause) {
      if (request === switchRequest.current) setError(String(cause));
    }
  };

  // Auto-play next episode when video reaches EOF
  useEffect(() => {
    if (status.eofReached && queue.length > 1 && current) {
      const currIdx = queue.findIndex((f) => f.id === current.id);
      if (currIdx >= 0 && currIdx < queue.length - 1) {
        void switchEpisode(queue[currIdx + 1]);
      }
    }
  }, [status.eofReached, queue, current?.id]);

  const handleGenerateAiSubtitles = async () => {
    if (!current) return;
    setAiGenerating(true);
    setAiErrorMsg(null);
    setAiSuccessMsg(null);
    setAiProgress({
      fileId: current.id,
      stage: "starting",
      percent: 5,
      message: "准备生成 AI 字幕...",
    });

    localStorage.setItem("cove_ai_provider", aiProvider);
    if (aiBaseUrl) localStorage.setItem("cove_ai_base_url", aiBaseUrl);
    if (aiModel) localStorage.setItem("cove_ai_model", aiModel);
    localStorage.setItem("cove_ai_mode", aiMode);

    try {
      await saveAiKey(aiKey);
      const result = await generateAiSubtitles(current.id, {
        provider: aiProvider,
        apiKey: aiKey,
        baseUrl: aiBaseUrl.trim() || undefined,
        model: aiModel.trim() || undefined,
        mode: aiMode,
        scope: aiScope,
        language: aiLang === "auto" ? undefined : aiLang,
      });
      if (currentId.current !== result.fileId) return;
      setAiSuccessMsg(`生成成功，共 ${result.segmentCount} 条字幕，${result.applied ? "已加载" : "已保存"}。`);
      setCachedSrt(result.srtPath);
      setAiProgress(null);
    } catch (err) {
      setAiErrorMsg(err instanceof Error ? err.message : String(err));
      setAiProgress(null);
    } finally {
      setAiGenerating(false);
    }
  };

  if (!current) return <main className="player-overlay-window" />;

  return (
    <main className={`player-overlay-window ${visible ? "visible" : "hidden"}`}>
      <button
        type="button"
        className="overlay-back-btn"
        title="返回目录 (Esc)"
        onClick={() => void controlPlayer("stop")}
      >
        <ArrowLeft size={16} />
        <span>返回目录</span>
      </button>

      <div className="overlay-title">{error || status.error || current.displayName}</div>

      {episodeDrawer && (
        <button
          className="drawer-dismiss-layer"
          aria-label="关闭选集"
          onClick={() => setEpisodeDrawer(false)}
        />
      )}

      {episodeDrawer && (
        <aside className="episode-drawer">
          <header>
            <div>
              <strong>{seasons.length > 1 ? `${seasons.length} 季` : "选集列表"}</strong>
              <span>共 {queue.length} 个视频</span>
            </div>
            <button
              className="drawer-close-btn"
              title="关闭"
              onClick={() => setEpisodeDrawer(false)}
            >
              <X size={16} />
            </button>
          </header>
          {seasons.length > 1 && (
            <div className="drawer-seasons">
              {seasons.map((season) => (
                <button
                  className={drawerSeason === season ? "active" : ""}
                  key={season}
                  onClick={() => setDrawerSeason(season)}
                >
                  第 {season} 季
                </button>
              ))}
            </div>
          )}
          <div className="drawer-episodes">
            {queue
              .filter((file) => (seasons.length > 1 ? seasonOf(file) === drawerSeason : true))
              .map((file, itemIndex) => {
                const hasEp = (episodeOf(file) ?? 0) > 0;
                const isSeries = seasons.length > 1;
                const label =
                  hasEp && isSeries
                    ? episodeLabel(file, itemIndex)
                    : cleanWorkTitle(file.displayName) || file.displayName;
                return (
                  <button
                    ref={file.id === current.id ? activeEpisode : undefined}
                    className={`drawer-item-btn ${file.id === current.id ? "active" : ""}`}
                    key={file.id}
                    title={file.displayName}
                    onClick={() => void switchEpisode(file)}
                  >
                    <span className="drawer-number">{label}</span>
                    {file.id === current.id && (
                      <span className="drawer-playing">
                        <AudioLines size={14} />
                        播放中
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        </aside>
      )}

      {/* AI Subtitles Modal */}
      {aiModalOpen && (
        <div className="ai-sub-modal-overlay">
          <div className="ai-sub-modal">
            <header className="ai-sub-modal-header">
              <div className="ai-sub-header-title">
                <Sparkles size={18} className="ai-sparkle-icon" />
                <strong>AI 字幕助手</strong>
                {cachedSrt && <span className="ai-badge-cached">已装载本地字幕</span>}
              </div>
              <button
                type="button"
                className="ai-modal-close"
                title="关闭"
                onClick={() => setAiModalOpen(false)}
              >
                <X size={16} />
              </button>
            </header>

            <div className="ai-sub-body">
              <div className="ai-form-group">
                <label>AI 服务提供商</label>
                <div className="ai-provider-tabs">
                  <button
                    type="button"
                    className={`ai-provider-tab ${aiProvider === "siliconflow" ? "active" : ""}`}
                    onClick={() => {
                      setAiProvider("siliconflow");
                      setAiModel("FunAudioLLM/SenseVoiceSmall");
                    }}
                  >
                    <span>硅基流动</span>
                    <span className="ai-tab-tag">国内免翻</span>
                  </button>
                  <button
                    type="button"
                    className={`ai-provider-tab ${aiProvider === "groq" ? "active" : ""}`}
                    onClick={() => {
                      setAiProvider("groq");
                      setAiModel("whisper-large-v3");
                    }}
                  >
                    <span>Groq</span>
                    <span className="ai-tab-tag">超极速免费</span>
                  </button>
                  <button
                    type="button"
                    className={`ai-provider-tab ${aiProvider === "openai" ? "active" : ""}`}
                    onClick={() => {
                      setAiProvider("openai");
                      setAiModel("whisper-1");
                    }}
                  >
                    <span>OpenAI</span>
                    <span className="ai-tab-tag">官方</span>
                  </button>
                  <button
                    type="button"
                    className={`ai-provider-tab ${aiProvider === "custom" ? "active" : ""}`}
                    onClick={() => setAiProvider("custom")}
                  >
                    <span>自定义</span>
                    <span className="ai-tab-tag">本地/兼容</span>
                  </button>
                </div>
              </div>

              <div className="ai-form-group">
                <div className="ai-label-with-link">
                  <label>API Key 密钥</label>
                  {aiProvider === "siliconflow" && (
                    <a
                      href="https://cloud.siliconflow.cn/"
                      target="_blank"
                      rel="noreferrer"
                      className="ai-key-link"
                    >
                      获取硅基流动 Key (赠额度) <ExternalLink size={12} />
                    </a>
                  )}
                  {aiProvider === "groq" && (
                    <a
                      href="https://console.groq.com/keys"
                      target="_blank"
                      rel="noreferrer"
                      className="ai-key-link"
                    >
                      获取 Groq 免费 Key <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                <input
                  type="password"
                  className="ai-input"
                  placeholder={
                    aiProvider === "siliconflow"
                      ? "sk-..."
                      : aiProvider === "groq"
                      ? "gsk_..."
                      : "sk-..."
                  }
                  value={aiKey}
                  onChange={(e) => setAiKey(e.target.value)}
                />
              </div>

              {aiProvider === "custom" && (
                <div className="ai-form-row">
                  <div className="ai-form-group flex-1">
                    <label>Base URL 接口地址</label>
                    <input
                      type="text"
                      className="ai-input"
                      placeholder="http://127.0.0.1:8000/v1/audio/transcriptions"
                      value={aiBaseUrl}
                      onChange={(e) => setAiBaseUrl(e.target.value)}
                    />
                  </div>
                  <div className="ai-form-group flex-1">
                    <label>Model 模型名称</label>
                    <input
                      type="text"
                      className="ai-input"
                      placeholder="whisper-large-v3"
                      value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div className="ai-form-row">
                <div className="ai-form-group flex-1">
                  <label>字幕模式</label>
                  <select
                    className="ai-select"
                    value={aiMode}
                    onChange={(e) => setAiMode(e.target.value as any)}
                  >
                    <option value="translate_zh">翻译为中文 (推荐)</option>
                    <option value="bilingual">双语字幕 (原文 + 中文)</option>
                    <option value="original">原语言听写</option>
                  </select>
                </div>
                <div className="ai-form-group flex-1">
                  <label>生成范围</label>
                  <select
                    className="ai-select"
                    value={aiScope}
                    onChange={(e) => setAiScope(e.target.value as any)}
                  >
                    <option value="preview">前 5 分钟试听 (秒出)</option>
                    <option value="full">全片完整字幕</option>
                  </select>
                </div>
              </div>

              {aiProgress && (
                <div className="ai-progress-card">
                  <div className="ai-progress-bar-bg">
                    <div
                      className="ai-progress-bar-fill"
                      style={{ width: `${aiProgress.percent}%` }}
                    />
                  </div>
                  <div className="ai-progress-text">
                    <LoaderCircle size={14} className="spin" />
                    <span>{aiProgress.message}</span>
                  </div>
                </div>
              )}

              {aiSuccessMsg && <div className="ai-notice-success"><Check size={15} /> {aiSuccessMsg}</div>}
              {aiErrorMsg && <div className="ai-notice-error">{aiErrorMsg}</div>}
            </div>

            <footer className="ai-sub-modal-footer">
              <button
                type="button"
                className="ai-cancel-btn"
                onClick={() => setAiModalOpen(false)}
              >
                关闭
              </button>
              <button
                type="button"
                disabled={aiGenerating || (!aiKey.trim() && aiProvider !== "custom")}
                className="ai-submit-btn"
                onClick={handleGenerateAiSubtitles}
              >
                {aiGenerating ? (
                  <>
                    <LoaderCircle size={15} className="spin" />
                    <span>AI 正在生成...</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={15} />
                    <span>{cachedSrt ? "重新生成字幕" : "开始生成并加载"}</span>
                  </>
                )}
              </button>
            </footer>
          </div>
        </div>
      )}

      <section className="floating-playback">
        <div className="floating-control-card">
          <div className="floating-progress">
            <span>{formatTime(status.position)}</span>
            <input
              aria-label="播放进度"
              type="range"
              min="0"
              max={Math.max(status.duration, 1)}
              value={Math.min(localPosition, Math.max(status.duration, 1))}
              onChange={(event) => {
                draggingProgress.current = true;
                setLocalPosition(Number(event.target.value));
              }}
              onPointerUp={() => {
                draggingProgress.current = false;
                void controlPlayer("seek_absolute", localPosition);
              }}
              onMouseUp={() => {
                draggingProgress.current = false;
                void controlPlayer("seek_absolute", localPosition);
              }}
            />
            <span>{formatTime(status.duration)}</span>
          </div>
          <div className="floating-toolbar">
            <div>
              <button
                title="静音"
                onClick={() => void controlPlayer("volume", status.volume > 0 ? 0 : 100)}
              >
                <Volume2 size={20} />
              </button>
              <input
                className="floating-volume"
                aria-label="音量"
                type="range"
                min="0"
                max="100"
                value={localVolume}
                onChange={(event) => {
                  draggingVolume.current = true;
                  setLocalVolume(Number(event.target.value));
                }}
                onPointerUp={() => {
                  draggingVolume.current = false;
                  void controlPlayer("volume", localVolume);
                }}
                onMouseUp={() => {
                  draggingVolume.current = false;
                  void controlPlayer("volume", localVolume);
                }}
              />
              <select
                aria-label="倍速"
                value={status.speed}
                onChange={(event) => void controlPlayer("speed", Number(event.target.value))}
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((speed) => (
                  <option key={speed} value={speed}>
                    {speed.toFixed(1)}x
                  </option>
                ))}
              </select>
            </div>
            <div className="floating-center">
              <button
                disabled={index <= 0}
                onClick={() => index > 0 && void switchEpisode(queue[index - 1])}
              >
                <SkipBack size={22} fill="currentColor" />
              </button>
              <button className="floating-play" onClick={() => void controlPlayer("play_pause")}>
                {status.paused ? <Play size={25} fill="currentColor" /> : <Pause size={25} fill="currentColor" />}
              </button>
              <button
                disabled={index < 0 || index >= queue.length - 1}
                onClick={() => index >= 0 && index < queue.length - 1 && void switchEpisode(queue[index + 1])}
              >
                <SkipForward size={22} fill="currentColor" />
              </button>
            </div>
            <div className="floating-right">
              {status.tracks.some((track) => track.kind === "audio") && (
                <label title="切换音轨">
                  <AudioLines size={20} />
                  <select
                    aria-label="音轨"
                    value={status.tracks.find((track) => track.kind === "audio" && track.selected)?.id ?? -1}
                    onChange={(event) => void controlPlayer("audio", Number(event.target.value))}
                  >
                    {status.tracks
                      .filter((track) => track.kind === "audio")
                      .map((track) => (
                        <option value={track.id} key={track.id}>
                          {track.title || track.language || `音轨 ${track.id}`}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label title="字幕">
                <Captions size={21} />
                <select
                  aria-label="字幕"
                  value={status.tracks.find((track) => track.kind === "sub" && track.selected)?.id ?? -1}
                  onChange={(event) => void controlPlayer("subtitle", Number(event.target.value))}
                >
                  <option value="-1">字幕关闭</option>
                  {status.tracks
                    .filter((track) => track.kind === "sub")
                    .map((track) => (
                      <option value={track.id} key={track.id}>
                        {track.title || track.language || "字幕"}
                      </option>
                    ))}
                </select>
              </label>

              {/* AI Subtitles Button */}
              <button
                className={`floating-ai-btn ${aiModalOpen ? "active" : ""}`}
                title="AI 字幕助手"
                onClick={() => {
                  setAiModalOpen((v) => !v);
                  setEpisodeDrawer(false);
                }}
              >
                <Sparkles size={17} />
                <span>AI字幕</span>
              </button>

              {queue.length > 1 && (
                <button
                  className={episodeDrawer ? "active" : ""}
                  title="选集"
                  onClick={() => {
                    setEpisodeDrawer((value) => !value);
                    setAiModalOpen(false);
                  }}
                >
                  <List size={22} />
                </button>
              )}
              <button title="全屏" onClick={() => void controlPlayer("fullscreen")}>
                <Maximize size={21} />
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
