import { useState, type FormEvent } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { providerLabel } from "../lib/media";
import { configureSync, type Account, type SyncStatus } from "../lib/nimbus";
import { isWindows } from "../lib/platform";
import { Popup } from "../ui/controls";
import { Sheet } from "../ui/Sheet";

/** Storage that can hold the sync folder: what Cove can write a small file to. */
const SYNC_PROVIDERS = ["baidu", "webdav", "smb", "local"];
const OFF = "off";

type Props = {
  status: SyncStatus;
  accounts: Account[];
  onClose: () => void;
  onSaved: (status: SyncStatus) => void;
};

/** Where this computer meets the others: an account and a folder on it. */
export function SyncSettingsSheet({ status, accounts, onClose, onSaved }: Props) {
  const choices = accounts.filter((account) => SYNC_PROVIDERS.includes(account.provider));
  const [accountId, setAccountId] = useState(status.accountId ?? OFF);
  const [folder, setFolder] = useState(status.accountId ? status.folder : "");
  const [deviceName, setDeviceName] = useState(status.deviceName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const local = accounts.find((account) => account.id === accountId)?.provider === "local";
  const ready = accountId === OFF || !local || !!folder.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError("");
    try {
      onSaved(await configureSync(accountId === OFF ? null : accountId, folder, deviceName));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet onClose={onClose} labelledBy="sync-settings-title" width={500} dismissOnBackdrop={false}>
      <form onSubmit={submit}>
        <div className="sheet-header">
          <div>
            <h2 className="sheet-title" id="sync-settings-title">
              多端同步
            </h2>
            <p className="sheet-subtitle">在几台电脑间同步媒体文件夹、播放和阅读进度、播放列表。</p>
          </div>
        </div>
        <div className="sheet-body">
          <div className="form-grid">
            <label>同步位置</label>
            <div>
              <Popup
                ariaLabel="同步位置"
                value={accountId}
                onChange={(value) => {
                  setAccountId(value);
                  setFolder("");
                  setError("");
                }}
                options={[
                  { value: OFF, label: "关闭" },
                  ...choices.map((account) => ({
                    value: account.id,
                    label: account.provider === "local" ? "本机文件夹" : `${account.label}（${providerLabel(account.provider)}）`,
                  })),
                ]}
              />
            </div>
            {accountId !== OFF && (
              <>
                <label htmlFor="sync-folder">文件夹</label>
                <input
                  id="sync-folder"
                  className="field"
                  required={local}
                  value={folder}
                  placeholder={local ? (isWindows ? "C:\\Users\\我\\OneDrive\\Cove 同步" : "/Users/我/Library/Mobile Documents/Cove 同步") : "/Cove 同步"}
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(event) => setFolder(event.target.value)}
                />
                <label htmlFor="sync-device">这台电脑</label>
                <input
                  id="sync-device"
                  className="field"
                  value={deviceName}
                  placeholder={status.deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                />
              </>
            )}
          </div>
          <p className="form-note">
            {local
              ? "选一个会被其他应用同步的文件夹（如 OneDrive、iCloud 云盘、坚果云），其他电脑选它们那边的同一个文件夹。"
              : "每台电脑都选同一个网盘账号和同一个文件夹。"}
            每台电脑只写自己的同步文件，同一条记录以较新的为准。本机磁盘上的文件夹不参与同步，密码和授权也不会离开这台电脑。
          </p>
          {!choices.some((account) => account.provider !== "local") && accountId === OFF && (
            <p className="form-note">还没有可用的网盘：先添加百度网盘、WebDAV 或 SMB 共享，再回来选择。</p>
          )}
          {error && (
            <p className="form-error" role="alert">
              <CircleAlert size={14} />
              {error}
            </p>
          )}
        </div>
        <div className="sheet-footer">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn prominent" disabled={!ready || saving}>
            {saving && <LoaderCircle className="spin" size={12} />}
            保存
          </button>
        </div>
      </form>
    </Sheet>
  );
}
