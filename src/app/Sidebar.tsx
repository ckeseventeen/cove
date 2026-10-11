import { forwardRef } from "react";
import { Clapperboard, House, LoaderCircle, Music, Plus } from "lucide-react";
import { showContextMenu } from "../lib/native";
import type { Account, MediaSource } from "../lib/nimbus";
import { SearchField } from "../ui/controls";
import { providerIcon } from "../ui/glyphs";
import { sidebarKey, type Route } from "./navigation";
import type { Library } from "./useLibrary";

type Props = {
  route: Route;
  library: Library;
  query: string;
  onQuery: (value: string) => void;
  onSearchKey: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onNavigate: (route: Route) => void;
  onAddStorage: () => void;
  onRemoveAccount: (account: Account) => void;
  onRemoveSource: (source: MediaSource) => void;
  onWindowMouseDown: (event: React.MouseEvent) => void;
};

/** One row per destination: library, storage locations, media folders. Everything else lives in menus. */
export const Sidebar = forwardRef<HTMLInputElement, Props>(function Sidebar(
  { route, library, query, onQuery, onSearchKey, onNavigate, onAddStorage, onRemoveAccount, onRemoveSource, onWindowMouseDown },
  searchRef,
) {
  const active = sidebarKey(route);
  const current = (key: string) => (active === key ? "page" : undefined);

  return (
    <aside className="sidebar" aria-label="边栏">
      <div className="sidebar-header" data-tauri-drag-region onMouseDown={onWindowMouseDown} />
      <div className="sidebar-search">
        <SearchField ref={searchRef} value={query} onChange={onQuery} onKeyDown={onSearchKey} placeholder="搜索" ariaLabel="搜索资料库" />
      </div>
      <nav className="sidebar-scroll">
        <section className="sidebar-section">
          <h2 className="sidebar-heading">
            <span>资料库</span>
          </h2>
          <button className="sidebar-item" aria-current={current("home")} onClick={() => onNavigate({ name: "home" })}>
            <House size={16} />
            <span className="label">首页</span>
          </button>
          <button className="sidebar-item" aria-current={current("movies")} onClick={() => onNavigate({ name: "movies" })}>
            <Clapperboard size={16} />
            <span className="label">影视</span>
            <span className="trailing">{library.works.length || ""}</span>
          </button>
          <button className="sidebar-item" aria-current={current("music")} onClick={() => onNavigate({ name: "music" })}>
            <Music size={16} />
            <span className="label">音乐</span>
            <span className="trailing">{library.songs.length || ""}</span>
          </button>
        </section>

        <section className="sidebar-section">
          <h2 className="sidebar-heading">
            <span>位置</span>
            <button className="icon-btn small" title="添加存储…" aria-label="添加存储" onClick={onAddStorage}>
              <Plus size={13} />
            </button>
          </h2>
          {library.accounts.map((account) => {
            const Icon = providerIcon(account.provider);
            const open = () => onNavigate({ name: "storage", accountId: account.id, path: "/" });
            return (
              <button
                key={account.id}
                className="sidebar-item"
                aria-current={current(`account:${account.id}`)}
                title={account.label}
                onClick={open}
                onContextMenu={(event) =>
                  void showContextMenu(event, [
                    { label: "打开", action: open },
                    ...(account.provider !== "local"
                      ? (["separator", { label: `移除“${account.label}”…`, destructive: true, action: () => onRemoveAccount(account) }] as const)
                      : []),
                  ])
                }
              >
                <Icon size={16} />
                <span className="label">{account.label}</span>
              </button>
            );
          })}
        </section>

        {library.sources.length > 0 && (
          <section className="sidebar-section">
            <h2 className="sidebar-heading">
              <span>媒体文件夹</span>
            </h2>
            {library.sources.map((source) => {
              const scanning = library.scanningIds.has(source.id);
              const open = () => onNavigate({ name: source.kind === "movie" ? "movies" : "music", sourceId: source.id });
              return (
                <button
                  key={source.id}
                  className="sidebar-item"
                  aria-current={current(`source:${source.id}`)}
                  title={`${source.label}\n${source.remoteRoot}`}
                  onClick={open}
                  onContextMenu={(event) =>
                    void showContextMenu(event, [
                      { label: "显示", action: open },
                      { label: "在文件中显示", action: () => onNavigate({ name: "storage", accountId: source.accountId, path: source.remoteRoot }) },
                      { label: "重新扫描", enabled: !scanning, action: () => void library.scanSource(source) },
                      "separator",
                      { label: `移除“${source.label}”…`, destructive: true, action: () => onRemoveSource(source) },
                    ])
                  }
                >
                  {source.kind === "movie" ? <Clapperboard size={16} /> : <Music size={16} />}
                  <span className="label">{source.label}</span>
                  {scanning && (
                    <span className="trailing">
                      <LoaderCircle className="spin" size={12} aria-label="正在扫描" />
                    </span>
                  )}
                </button>
              );
            })}
          </section>
        )}
      </nav>
    </aside>
  );
});
