import { useState } from "react";
import { Clapperboard, Ellipsis, LoaderCircle, Music } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { formatRelative, plural } from "../lib/format";
import { providerLabel } from "../lib/media";
import { showContextMenu } from "../lib/native";
import { clearMetadataCache, type Account, type MediaSource } from "../lib/nimbus";
import { ProviderGlyph } from "../ui/glyphs";
import type { Notify } from "../ui/Toasts";

type Props = {
  library: Library;
  notify: Notify;
  onNavigate: (route: Route) => void;
  onAddStorage: () => void;
  onRemoveAccount: (account: Account) => void;
  onRemoveSource: (source: MediaSource) => void;
};

function StatusValue({ state, on, off }: { state: boolean | undefined; on: string; off: string }) {
  if (state === undefined) return <span className="row-value">正在检查…</span>;
  return (
    <span className="row-value">
      <span className={`status-dot ${state ? "ok" : "off"}`} />
      {state ? on : off}
    </span>
  );
}

/** System Settings–style grouped form. */
export function SettingsView({ library, notify, onNavigate, onAddStorage, onRemoveAccount, onRemoveSource }: Props) {
  const [pending, setPending] = useState<"clear" | "refresh" | null>(null);
  const { status } = library;

  const run = async (action: "clear" | "refresh") => {
    if (pending) return;
    setPending(action);
    try {
      if (action === "clear") {
        await clearMetadataCache();
        library.clearMovieMetadata();
        notify("已清除资料缓存。再次浏览时会重新匹配海报与简介。", "success");
      } else {
        await library.refresh();
        notify("状态已刷新", "success");
      }
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), "error");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="page narrow">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">设置</h1>
        </div>
      </header>

      <section className="group">
        <h2 className="group-title">存储位置</h2>
        <div className="group-box">
          {library.accounts.map((account) => (
            <div className="group-row" key={account.id}>
              <ProviderGlyph provider={account.provider} />
              <span className="row-main">
                <span className="row-title">{account.label}</span>
                <span className="row-subtitle">{account.provider === "local" ? "这台 Mac" : providerLabel(account.provider)}</span>
              </span>
              <button
                className="icon-btn"
                title="更多"
                aria-label={`${account.label} 的更多操作`}
                onClick={(event) =>
                  void showContextMenu(event, [
                    { label: "打开", action: () => onNavigate({ name: "storage", accountId: account.id, path: "/" }) },
                    ...(account.provider !== "local"
                      ? (["separator", { label: "移除…", destructive: true, action: () => onRemoveAccount(account) }] as const)
                      : []),
                  ])
                }
              >
                <Ellipsis size={15} />
              </button>
            </div>
          ))}
        </div>
        <p className="group-footer">
          密码与授权令牌只保存在 macOS 钥匙串中，移除账号不会改动存储中的文件。{" "}
          <button className="btn plain inline" onClick={onAddStorage}>
            添加存储…
          </button>
        </p>
      </section>

      <section className="group">
        <h2 className="group-title">媒体文件夹</h2>
        <div className="group-box">
          {library.sources.map((source) => {
            const scanning = library.scanningIds.has(source.id);
            const provider = library.accounts.find((account) => account.id === source.accountId)?.provider ?? "";
            return (
              <div className="group-row" key={source.id}>
                <span className={`glyph ${source.kind === "movie" ? "purple" : "pink"}`}>
                  {source.kind === "movie" ? <Clapperboard size={15} /> : <Music size={15} />}
                </span>
                <span className="row-main">
                  <span className="row-title">{source.label}</span>
                  <span className="row-subtitle" title={source.remoteRoot}>
                    {providerLabel(provider)} · {source.remoteRoot}
                  </span>
                </span>
                <span className="row-value">
                  {scanning ? <LoaderCircle className="spin" size={12} /> : null}
                  {scanning ? "正在扫描" : `扫描于 ${formatRelative(source.lastScanAt)}`}
                </span>
                <button
                  className="icon-btn"
                  title="更多"
                  aria-label={`${source.label} 的更多操作`}
                  onClick={(event) =>
                    void showContextMenu(event, [
                      { label: "重新扫描", enabled: !scanning, action: () => void library.scanSource(source) },
                      { label: "在文件中显示", action: () => onNavigate({ name: "storage", accountId: source.accountId, path: source.remoteRoot }) },
                      "separator",
                      { label: "移除…", destructive: true, action: () => onRemoveSource(source) },
                    ])
                  }
                >
                  <Ellipsis size={15} />
                </button>
              </div>
            );
          })}
          {!library.sources.length && (
            <div className="group-row">
              <span className="row-main row-subtitle">还没有媒体文件夹。在“位置”中打开文件夹，选择“添加到资料库”。</span>
            </div>
          )}
        </div>
        <p className="group-footer">
          只扫描这里列出的文件夹及其子文件夹，共索引 {plural(library.files.length, "个媒体文件")}，不会下载云端原文件。
        </p>
      </section>

      <section className="group">
        <h2 className="group-title">服务</h2>
        <div className="group-box">
          <div className="group-row">
            <span className="row-main">
              <span className="row-title">百度网盘授权</span>
              <span className="row-subtitle">登录百度网盘所需的开放平台应用配置</span>
            </span>
            <StatusValue state={status?.baiduConfigured} on="已配置" off="未配置" />
          </div>
          <div className="group-row">
            <span className="row-main">
              <span className="row-title">TMDB 影视资料</span>
              <span className="row-subtitle">海报、简介与中文片名</span>
            </span>
            <StatusValue state={status?.tmdbConfigured} on="已配置" off="未配置" />
          </div>
          <div className="group-row">
            <span className="row-main">
              <span className="row-title">播放内核</span>
              <span className="row-subtitle">libmpv 硬件解码，支持多音轨与字幕</span>
            </span>
            <StatusValue state={status?.mpvAvailable} on="可用" off="不可用" />
          </div>
          <div className="group-row">
            <span className="row-main">
              <span className="row-title">本地数据库</span>
              <span className="row-subtitle">{status?.platform ?? "macOS"}</span>
            </span>
            <StatusValue state={status?.databaseReady} on="正常" off="初始化中" />
          </div>
        </div>
        <p className="group-footer">云端播放通过只监听 127.0.0.1 的本机代理进行，播放链接使用短期令牌。</p>
      </section>

      <section className="group">
        <h2 className="group-title">维护</h2>
        <div className="group-box">
          <div className="group-row">
            <span className="row-main">
              <span className="row-title">资料缓存</span>
              <span className="row-subtitle">清除后，海报、简介与歌词会在下次浏览时重新获取</span>
            </span>
            <button className="btn" disabled={pending !== null} onClick={() => void run("clear")}>
              {pending === "clear" && <LoaderCircle className="spin" size={12} />}
              清除缓存
            </button>
          </div>
          <div className="group-row">
            <span className="row-main">
              <span className="row-title">连接与索引状态</span>
              <span className="row-subtitle">重新读取账号、媒体文件夹与服务配置</span>
            </span>
            <button className="btn" disabled={pending !== null} onClick={() => void run("refresh")}>
              {pending === "refresh" && <LoaderCircle className="spin" size={12} />}
              刷新
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
