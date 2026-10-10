import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { Library } from "../app/useLibrary";
import { clearMetadataCache } from "../lib/nimbus";
import { plural } from "../lib/format";
import type { Notify } from "../ui/Toasts";

type Props = { library: Library; notify: Notify };

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
export function SettingsView({ library, notify }: Props) {
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
        <h2 className="group-title">资料库</h2>
        <div className="group-box">
          <div className="group-row">
            <span className="row-main row-title">云端存储账号</span>
            <span className="row-value">{library.accounts.filter((account) => account.provider !== "local").length}</span>
          </div>
          <div className="group-row">
            <span className="row-main row-title">媒体文件夹</span>
            <span className="row-value">{library.sources.length}</span>
          </div>
          <div className="group-row">
            <span className="row-main row-title">已索引的媒体文件</span>
            <span className="row-value">{plural(library.files.length, "个")}</span>
          </div>
        </div>
        <p className="group-footer">索引只保存文件名、路径和大小等信息，不会下载云端原文件。</p>
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
