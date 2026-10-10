import { Ellipsis, Film, FolderSearch, LoaderCircle, Music2, RefreshCw } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { formatRelative } from "../lib/format";
import { providerLabel } from "../lib/media";
import { showContextMenu } from "../lib/native";
import type { MediaSource } from "../lib/nimbus";
import { EmptyState } from "../ui/controls";

type Props = {
  library: Library;
  onNavigate: (route: Route) => void;
  onRemoveSource: (source: MediaSource) => void;
};

/** Folders that feed the library, with scan status and actions. */
export function SourcesView({ library, onNavigate, onRemoveSource }: Props) {
  const groups: [MediaSource["kind"], string][] = [
    ["movie", "影视文件夹"],
    ["music", "音乐文件夹"],
  ];
  const providerOf = (source: MediaSource) => library.accounts.find((account) => account.id === source.accountId)?.provider ?? "";
  const scanAll = () => library.sources.forEach((source) => void library.scanSource(source));

  return (
    <div className="page narrow">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">媒体文件夹</h1>
          <p className="page-subtitle">Cove 只整理这里列出的文件夹及其子文件夹，不会扫描整个磁盘或网盘。</p>
        </div>
        <div className="page-actions">
          <button className="btn large" disabled={!library.sources.length || library.scanningIds.size > 0} onClick={scanAll}>
            <RefreshCw size={13} />
            全部重新扫描
          </button>
        </div>
      </header>

      {!library.sources.length ? (
        <EmptyState
          icon={<FolderSearch size={44} strokeWidth={1.3} />}
          title="还没有媒体文件夹"
          message="打开“文件”，进入一个文件夹，然后选择“设为影视文件夹”或“设为音乐文件夹”。"
        >
          <button className="btn" onClick={() => onNavigate({ name: "files" })}>
            前往文件
          </button>
        </EmptyState>
      ) : (
        groups.map(([kind, title]) => {
          const items = library.sources.filter((source) => source.kind === kind);
          if (!items.length) return null;
          return (
            <section className="group" key={kind}>
              <h2 className="group-title">{title}</h2>
              <div className="group-box">
                {items.map((source) => {
                  const scanning = library.scanningIds.has(source.id);
                  const open = () => onNavigate({ name: kind === "movie" ? "movies" : "music", sourceId: source.id });
                  const reveal = () => onNavigate({ name: "storage", accountId: source.accountId, path: source.remoteRoot });
                  const items = [
                    { label: "在资料库中显示", action: open },
                    { label: "在文件中显示", action: reveal },
                    { label: "重新扫描", enabled: !scanning, action: () => void library.scanSource(source) },
                    "separator" as const,
                    { label: "移除…", destructive: true, action: () => onRemoveSource(source) },
                  ];
                  return (
                    <div className="group-row" key={source.id} onDoubleClick={open} onContextMenu={(event) => void showContextMenu(event, items)}>
                      <span className={`glyph ${kind === "movie" ? "purple" : "pink"}`}>
                        {kind === "movie" ? <Film size={15} /> : <Music2 size={15} />}
                      </span>
                      <span className="row-main">
                        <span className="row-title">{source.label}</span>
                        <span className="row-subtitle" title={source.remoteRoot}>
                          {providerLabel(providerOf(source))} · {source.remoteRoot}
                        </span>
                      </span>
                      <span className="row-value">{scanning ? "正在扫描…" : `扫描于 ${formatRelative(source.lastScanAt)}`}</span>
                      <span className="row-actions">
                        <button
                          className="icon-btn"
                          disabled={scanning}
                          title="重新扫描"
                          aria-label={`重新扫描 ${source.label}`}
                          onClick={() => void library.scanSource(source)}
                        >
                          {scanning ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                        </button>
                        <button
                          className="icon-btn"
                          title="更多"
                          aria-label={`${source.label} 的更多操作`}
                          onClick={(event) => void showContextMenu(event, items)}
                        >
                          <Ellipsis size={15} />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
