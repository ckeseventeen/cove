import { useEffect, useState, type FormEvent } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { getServiceSettings, saveServiceSettings, type ServiceSettings, type ServiceSettingsChanges } from "../lib/nimbus";
import { SYSTEM } from "../lib/platform";
import { Sheet } from "../ui/Sheet";

type Props = {
  onClose: () => void;
  onSaved: () => void;
};

/** The Baidu open-platform app and the TMDB token, for builds that carry no .env. */
export function ServiceSettingsSheet({ onClose, onSaved }: Props) {
  const [saved, setSaved] = useState<ServiceSettings | null>(null);
  const [appKey, setAppKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [tmdbToken, setTmdbToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void getServiceSettings()
      .then((settings) => {
        if (!live) return;
        setSaved(settings);
        setAppKey(settings.baiduAppKey);
        setRedirectUri(settings.baiduRedirectUri);
      })
      .catch((cause) => live && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      live = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!saved || saving) return;
    // Secrets are never shown, so an empty field keeps what is saved.
    const changes: ServiceSettingsChanges = {
      NIMBUS_BAIDU_APP_KEY: appKey,
      NIMBUS_BAIDU_REDIRECT_URI: redirectUri,
    };
    if (secretKey.trim()) changes.NIMBUS_BAIDU_SECRET_KEY = secretKey;
    if (tmdbToken.trim()) changes.NIMBUS_TMDB_READ_ACCESS_TOKEN = tmdbToken;
    setSaving(true);
    setError("");
    try {
      await saveServiceSettings(changes);
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet onClose={onClose} labelledBy="service-settings-title" width={500} dismissOnBackdrop={false}>
      <form onSubmit={submit}>
        <div className="sheet-header">
          <div>
            <h2 className="sheet-title" id="service-settings-title">
              服务配置
            </h2>
            <p className="sheet-subtitle">登录百度网盘和获取影视资料需要的开放平台应用。</p>
          </div>
        </div>
        <div className="sheet-body">
          <div className="form-grid">
            <label htmlFor="service-baidu-key">百度 AppKey</label>
            <input
              id="service-baidu-key"
              className="field"
              value={appKey}
              autoCapitalize="off"
              spellCheck={false}
              data-autofocus
              onChange={(event) => setAppKey(event.target.value)}
            />
            <label htmlFor="service-baidu-secret">百度 SecretKey</label>
            <input
              id="service-baidu-secret"
              className="field"
              type="password"
              value={secretKey}
              placeholder={saved?.baiduSecretKeySaved ? "已保存，留空则不修改" : ""}
              onChange={(event) => setSecretKey(event.target.value)}
            />
            <label htmlFor="service-baidu-redirect">回调地址</label>
            <input
              id="service-baidu-redirect"
              className="field"
              value={redirectUri}
              placeholder={saved?.defaultBaiduRedirectUri}
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => setRedirectUri(event.target.value)}
            />
            <label htmlFor="service-tmdb">TMDB 令牌</label>
            <input
              id="service-tmdb"
              className="field"
              type="password"
              value={tmdbToken}
              placeholder={saved?.tmdbTokenSaved ? "已保存，留空则不修改" : "API 读访问令牌（可选）"}
              onChange={(event) => setTmdbToken(event.target.value)}
            />
          </div>
          <p className="form-note">
            在百度网盘开放平台（pan.baidu.com/union）创建应用后即可看到 AppKey 和 SecretKey；应用的授权回调地址要和这里一致，留空即为{" "}
            {saved?.defaultBaiduRedirectUri ?? "默认地址"}。TMDB 令牌在 themoviedb.org 的“设置 › API”中获取。这些配置保存在 {SYSTEM.systemKeychain}中。
          </p>
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
          <button type="submit" className="btn prominent" disabled={!saved || saving}>
            {saving && <LoaderCircle className="spin" size={12} />}
            保存
          </button>
        </div>
      </form>
    </Sheet>
  );
}
