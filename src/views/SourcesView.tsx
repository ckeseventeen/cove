import { Film, LoaderCircle, Music, RefreshCw, Trash2 } from "lucide-react";
import { providerName } from "../lib/media";
import type { Account, MediaSource } from "../lib/nimbus";

type Props = {
  sources: MediaSource[];
  accounts: Account[];
  onBrowse: (accountId: string) => void;
  onRemove: (source: MediaSource) => void;
  scanningIds?: Set<string>;
  onScan?: (source: MediaSource) => void;
};

export function SourcesView({ sources, accounts, onBrowse, onRemove, scanningIds, onScan }: Props) {
  return (
    <section className="media-grid source-grid">
      {sources.map((source) => {
        const isScanning = scanningIds?.has(source.id);
        return (
          <article className={`media-card ${source.kind === "movie" ? "violet" : "blue"}`} key={source.id}>
            <div className="poster-art">
              <span>{source.kind === "movie" ? "影视" : "音乐"}</span>
              {source.kind === "movie" ? <Film size={30} /> : <Music size={30} />}
            </div>
            <div className="card-copy">
              <h3>{source.label}</h3>
              <p>{providerName(source.accountId, accounts)} · {source.remoteRoot}</p>
              <p className="source-scanned">
                {isScanning
                  ? "正在增量扫描所有子文件夹…"
                  : source.lastScanAt
                  ? `上次扫描 ${new Date(source.lastScanAt * 1000).toLocaleString("zh-CN")}`
                  : "尚未完成完整扫描"}
              </p>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button className="button secondary" onClick={() => onBrowse(source.accountId)}>
                  浏览目录
                </button>
                {onScan && (
                  <button
                    className="button secondary"
                    disabled={isScanning}
                    onClick={() => onScan(source)}
                  >
                    {isScanning ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    {isScanning ? "扫描中" : "重新扫描"}
                  </button>
                )}
              </div>
              <button className="remove-library-button" onClick={() => onRemove(source)}>
                <Trash2 size={14} />移除{source.kind === "movie" ? "影视库" : "音乐库"}
              </button>
            </div>
          </article>
        );
      })}
      {sources.length === 0 && (
        <div className="empty-library">
          点击左侧云盘浏览文件夹，再把目标文件夹设为影视库或音乐库。全盘文件不会自动混进媒体库。
        </div>
      )}
    </section>
  );
}
