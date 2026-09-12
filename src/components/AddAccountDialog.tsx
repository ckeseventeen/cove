import { FormEvent, useState } from "react";
import { Cloud, LoaderCircle, X } from "lucide-react";
import type { Account, AccountInput } from "../lib/nimbus";
import { addAccount, connectBaidu } from "../lib/nimbus";

type Props = {
  open: boolean;
  onClose: () => void;
  onAdded: (account: Account) => void;
};

const emptyForm: AccountInput = { provider: "webdav", label: "", endpoint: "", username: "", password: "" };

const providers = [
  { value: "webdav", label: "WebDAV", enabled: true },
  { value: "google_drive", label: "Google Drive · OAuth Token", enabled: true },
  { value: "onedrive", label: "OneDrive · OAuth Token", enabled: true },
  { value: "baidu", label: "百度网盘 · 官方 OAuth", enabled: true },
  { value: "alidrive", label: "阿里云盘 · 等待 Client ID", enabled: false },
  { value: "quark", label: "夸克 · 无公开文件 API", enabled: false },
] as const;

export function AddAccountDialog({ open, onClose, onAdded }: Props) {
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const account = form.provider === "baidu"
        ? await connectBaidu(form.label)
        : await addAccount(form);
      onAdded(account);
      setForm(emptyForm);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-account-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="icon-button close" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        <div className="dialog-heading">
          <span className="dialog-icon"><Cloud size={22} /></span>
          <div><p className="eyebrow">新的存储源</p><h2 id="add-account-title">连接网盘</h2></div>
        </div>
        <form onSubmit={submit}>
          <label>网盘类型<select value={form.provider} onChange={(e) => setForm({ ...emptyForm, provider: e.target.value as AccountInput["provider"] })}>{providers.map((provider) => <option key={provider.value} value={provider.value} disabled={!provider.enabled}>{provider.label}</option>)}</select></label>
          <label>显示名称<input required value={form.label} placeholder="例如：家庭媒体库" onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
          {form.provider === "webdav" ? <><label>服务器地址<input required type="url" value={form.endpoint} placeholder="https://dav.example.com/" onChange={(e) => setForm({ ...form, endpoint: e.target.value })} /></label><div className="form-grid"><label>用户名<input value={form.username} autoComplete="username" onChange={(e) => setForm({ ...form, username: e.target.value })} /></label><label>密码<input required type="password" value={form.password} autoComplete="current-password" onChange={(e) => setForm({ ...form, password: e.target.value })} /></label></div></> : form.provider === "baidu" ? <p className="oauth-explainer">点击连接后会打开百度官方授权页面。Nimbus 只请求访问你主动授权的网盘文件。</p> : <label>OAuth Access Token<input required type="password" value={form.password} placeholder="由开发者 OAuth 应用签发" onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>}
          <p className="privacy-note">{form.provider === "webdav" ? "密码" : "访问令牌"}只会写入 macOS 钥匙串，不会保存在数据库中。</p>
          {error && <p className="form-error">{error}</p>}
          <div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving && <LoaderCircle className="spin" size={16} />}{form.provider === "baidu" ? "登录百度网盘" : "连接并验证"}</button></div>
        </form>
      </section>
    </div>
  );
}
