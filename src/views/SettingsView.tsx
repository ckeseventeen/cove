import type { Account, AppStatus, MediaFile, MediaSource } from "../lib/nimbus";

type Props = {
  accounts: Account[];
  sources: MediaSource[];
  files: MediaFile[];
  status: AppStatus | null;
  onClearMetadataCache: () => void;
  onRefreshStatus: () => void;
};

export function SettingsView({ accounts, sources, files, status, onClearMetadataCache, onRefreshStatus }: Props) {
  return (
    <section className="info-page">
      <p className="eyebrow">Cove 设置</p>
      <h2>本机与媒体库</h2>
      <div className="settings-actions">
        <button className="button secondary" onClick={onClearMetadataCache}>
          清理元数据缓存
        </button>
        <button className="button secondary" onClick={onRefreshStatus}>
          刷新连接与索引状态
        </button>
      </div>
      <div className="settings-grid">
        <article>
          <span>云盘账号</span>
          <strong>{accounts.filter((account) => account.provider !== "local").length}</strong>
          <p>OAuth 凭据保存在 macOS 钥匙串。</p>
        </article>
        <article>
          <span>媒体目录</span>
          <strong>{sources.length}</strong>
          <p>每个目录独立递归扫描和更新。</p>
        </article>
        <article>
          <span>百度 OAuth</span>
          <strong>{status?.baiduConfigured ? "已配置" : "未配置"}</strong>
          <p>个人版配置随应用构建，不依赖启动目录。</p>
        </article>
        <article>
          <span>TMDB 元数据</span>
          <strong>{status?.tmdbConfigured ? "已配置" : "未配置"}</strong>
          <p>用于影视海报和中文元数据刮削。</p>
        </article>
        <article>
          <span>mpv 播放内核</span>
          <strong>{status?.mpvAvailable ? "可用" : "未安装"}</strong>
          <p>用于硬件解码、音轨和字幕播放。</p>
        </article>
        <article>
          <span>索引文件</span>
          <strong>{files.length}</strong>
          <p>仅保存元数据，不下载云端原文件。</p>
        </article>
        <article>
          <span>运行环境</span>
          <strong>{status?.platform ?? "macOS"}</strong>
          <p>本地数据库：{status?.databaseReady ? "正常" : "初始化中"}</p>
        </article>
        <article>
          <span>流代理服务</span>
          <strong>127.0.0.1</strong>
          <p>仅本机回环播放代理，支持 Range 缓冲。</p>
        </article>
      </div>
    </section>
  );
}
