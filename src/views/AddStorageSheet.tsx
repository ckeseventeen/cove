import { useRef, useState, type FormEvent } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { addAccount, cancelBaiduSignIn, connectBaidu, updateAccountCredentials, type Account, type AccountInput } from "../lib/nimbus";
import { Popup } from "../ui/controls";
import { ProviderGlyph } from "../ui/glyphs";
import { Sheet } from "../ui/Sheet";

type Provider = AccountInput["provider"];

const PROVIDERS: { value: Provider; label: string; available: boolean }[] = [
  { value: "webdav", label: "WebDAV", available: true },
  { value: "baidu", label: "百度网盘", available: true },
  { value: "google_drive", label: "Google Drive", available: true },
  { value: "onedrive", label: "OneDrive", available: true },
  { value: "alidrive", label: "阿里云盘（暂不可用）", available: false },
  { value: "quark", label: "夸克网盘（暂不可用）", available: false },
];

const DEFAULT_NAMES: Partial<Record<Provider, string>> = {
  webdav: "WebDAV",
  baidu: "百度网盘",
  google_drive: "Google Drive",
  onedrive: "OneDrive",
};

type Props = {
  onClose: () => void;
  onAdded: (account: Account) => void;
  /** Reconnect this account instead of adding one: same id, so folders, progress and playlists stay. */
  account?: Account;
};

export function AddStorageSheet({ onClose, onAdded, account }: Props) {
  const [provider, setProvider] = useState<Provider>(account?.provider ?? "webdav");
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState(account?.endpoint ?? "");
  const [username, setUsername] = useState(account?.username ?? "");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Bumped by 取消 so a Baidu sign-in that ends afterwards leaves the closed sheet alone.
  const attempt = useRef(0);

  const name = account?.label ?? (label.trim() || DEFAULT_NAMES[provider] || "");
  const ready = !!name && (provider === "baidu" || (provider === "webdav" ? !!endpoint.trim() && !!password : !!password.trim()));
  // Waiting for the browser can be abandoned; the other checks finish on their own.
  const cancellable = !saving || provider === "baidu";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving) return;
    const current = ++attempt.current;
    setSaving(true);
    setError("");
    try {
      const connected =
        provider === "baidu"
          ? await connectBaidu(name, account?.id)
          : account
            ? await updateAccountCredentials(account.id, username.trim(), password)
            : await addAccount({ provider, label: name, endpoint: endpoint.trim(), username: username.trim(), password });
      // A sign-in that completed as 取消 was pressed still saved the account.
      onAdded(connected);
      if (current === attempt.current) onClose();
    } catch (cause) {
      if (current === attempt.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current === attempt.current) setSaving(false);
    }
  };

  const cancel = () => {
    if (!cancellable) return;
    if (saving) {
      attempt.current += 1;
      void cancelBaiduSignIn().catch(() => undefined);
    }
    onClose();
  };

  return (
    <Sheet onClose={cancel} labelledBy="add-storage-title" width={460} dismissOnBackdrop={false}>
      <form onSubmit={submit}>
        <div className="sheet-header">
          <ProviderGlyph provider={provider} size="large" />
          <div>
            <h2 className="sheet-title" id="add-storage-title">
              {account ? `重新连接“${account.label}”` : "添加存储"}
            </h2>
            <p className="sheet-subtitle">
              {account ? "更新密码或授权。资料库、播放进度和播放列表都会保留。" : "连接后即可浏览文件，并选择要加入资料库的文件夹。"}
            </p>
          </div>
        </div>
        <div className="sheet-body">
          <div className="form-grid">
            {!account && (
              <>
                <label>类型</label>
                <div>
                  <Popup<Provider>
                    ariaLabel="存储类型"
                    value={provider}
                    onChange={(value) => {
                      setProvider(value);
                      setError("");
                      setPassword("");
                    }}
                    options={PROVIDERS.map((item) => ({ value: item.value, label: item.label, disabled: !item.available }))}
                  />
                </div>
                <label htmlFor="storage-name">名称</label>
                <input
                  id="storage-name"
                  className="field"
                  value={label}
                  placeholder={DEFAULT_NAMES[provider]}
                  data-autofocus
                  onChange={(event) => setLabel(event.target.value)}
                />
              </>
            )}
            {provider === "webdav" && (
              <>
                <label htmlFor={account ? undefined : "storage-url"}>服务器</label>
                {account ? (
                  <span title={endpoint} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {endpoint}
                  </span>
                ) : (
                  <input
                    id="storage-url"
                    className="field"
                    type="url"
                    required
                    value={endpoint}
                    placeholder="https://dav.example.com/"
                    autoCapitalize="off"
                    spellCheck={false}
                    onChange={(event) => setEndpoint(event.target.value)}
                  />
                )}
                <label htmlFor="storage-user">用户名</label>
                <input
                  id="storage-user"
                  className="field"
                  value={username}
                  autoComplete="username"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(event) => setUsername(event.target.value)}
                />
                <label htmlFor="storage-password">密码</label>
                <input
                  id="storage-password"
                  className="field"
                  type="password"
                  required
                  value={password}
                  autoComplete="current-password"
                  data-autofocus={account ? true : undefined}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </>
            )}
            {(provider === "google_drive" || provider === "onedrive") && (
              <>
                <label htmlFor="storage-token">访问令牌</label>
                <input
                  id="storage-token"
                  className="field"
                  type="password"
                  required
                  value={password}
                  placeholder="OAuth Access Token"
                  data-autofocus={account ? true : undefined}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </>
            )}
          </div>
          <p className="form-note">
            {provider === "baidu"
              ? account
                ? "点击“登录”后会在浏览器中打开百度官方授权页面。请登录原来的百度账号，新的令牌会替换钥匙串中的旧令牌。"
                : "点击“登录”后会在浏览器中打开百度官方授权页面。Cove 只访问你授权的网盘文件，令牌保存在 macOS 钥匙串中。"
              : provider === "webdav"
                ? "为保护密码，远程服务器需要使用 HTTPS。密码只保存在 macOS 钥匙串中。"
                : account
                  ? "请粘贴同一账号新签发的访问令牌，它会替换钥匙串中的旧令牌。"
                  : "目前需要粘贴由 OAuth 应用签发的访问令牌，令牌保存在 macOS 钥匙串中。"}
          </p>
          {saving && provider === "baidu" && (
            <p className="form-note waiting">
              <LoaderCircle className="spin" size={12} /> 正在等待浏览器中的授权…
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              <CircleAlert size={14} />
              {error}
            </p>
          )}
        </div>
        <div className="sheet-footer">
          <button type="button" className="btn" disabled={!cancellable} onClick={cancel}>
            取消
          </button>
          <button type="submit" className="btn prominent" disabled={!ready || saving}>
            {saving && <LoaderCircle className="spin" size={12} />}
            {provider === "baidu" ? "登录" : account ? "重新连接" : "连接"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
