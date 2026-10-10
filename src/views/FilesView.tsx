import { ChevronRight, Plus } from "lucide-react";
import type { Route } from "../app/navigation";
import type { Library } from "../app/useLibrary";
import { providerLabel } from "../lib/media";
import { showContextMenu } from "../lib/native";
import type { Account } from "../lib/nimbus";
import { storageCapabilities } from "../lib/storage";
import { ProviderGlyph } from "../ui/glyphs";

type Props = {
  library: Library;
  onNavigate: (route: Route) => void;
  onAddStorage: () => void;
  onRemoveAccount: (account: Account) => void;
};

/** Every connected location, like Finder's Locations. */
export function FilesView({ library, onNavigate, onAddStorage, onRemoveAccount }: Props) {
  const local = library.accounts.filter((account) => account.provider === "local");
  const cloud = library.accounts.filter((account) => account.provider !== "local");
  const sourcesFor = (account: Account) => library.sources.filter((source) => source.accountId === account.id).length;

  const row = (account: Account) => {
    const capabilities = storageCapabilities(account.provider);
    const folders = sourcesFor(account);
    return (
      <button
        key={account.id}
        className="group-row"
        onClick={() => onNavigate({ name: "storage", accountId: account.id, path: "/" })}
        onContextMenu={(event) =>
          void showContextMenu(event, [
            { label: "打开", action: () => onNavigate({ name: "storage", accountId: account.id, path: "/" }) },
            ...(account.provider !== "local"
              ? (["separator", { label: `移除“${account.label}”…`, destructive: true, action: () => onRemoveAccount(account) }] as const)
              : []),
          ])
        }
      >
        <ProviderGlyph provider={account.provider} />
        <span className="row-main">
          <span className="row-title">{account.label}</span>
          <span className="row-subtitle">
            {account.provider === "local" ? "这台 Mac" : providerLabel(account.provider)}
            {" · "}
            {capabilities.copy ? "可浏览与拷贝" : "只读浏览"}
            {folders ? ` · ${folders} 个媒体文件夹` : ""}
          </span>
        </span>
        <ChevronRight className="chevron" size={14} />
      </button>
    );
  };

  return (
    <div className="page narrow">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">文件</h1>
          <p className="page-subtitle">浏览本机和云端存储。把文件夹设为影视或音乐后，它们会出现在资料库中。</p>
        </div>
        <div className="page-actions">
          <button className="btn large" onClick={onAddStorage}>
            <Plus size={14} />
            添加存储…
          </button>
        </div>
      </header>
      <section className="group">
        <h2 className="group-title">这台 Mac</h2>
        <div className="group-box">{local.map(row)}</div>
      </section>
      <section className="group">
        <h2 className="group-title">云端与网络</h2>
        <div className="group-box">
          {cloud.map(row)}
          <button className="group-row" onClick={onAddStorage}>
            <span className="glyph gray">
              <Plus size={15} />
            </span>
            <span className="row-main">
              <span className="row-title">添加存储…</span>
              <span className="row-subtitle">WebDAV、百度网盘、Google Drive、OneDrive</span>
            </span>
          </button>
        </div>
        <p className="group-footer">账号密码与授权令牌只保存在 macOS 钥匙串中。移除账号不会改动存储中的文件。</p>
      </section>
    </div>
  );
}
