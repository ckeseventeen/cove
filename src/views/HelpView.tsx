const SHORTCUTS: [string, string][] = [
  ["⌘F", "搜索资料库"],
  ["⌘1 – ⌘4", "首页、影视、音乐、文档"],
  ["⌘[ / ⌘]", "返回 / 前进"],
  ["⌃⌘S", "显示或隐藏边栏"],
  ["⌘,", "设置（存储账号、媒体文件夹）"],
  ["空格", "播放 / 暂停"],
  ["⌘→ / ⌘←", "下一首 / 上一首"],
  ["⌘↑ / ⌘↓", "调高 / 调低音量"],
  ["⌥⌘L / ⌥⌘U", "歌词 / 待播清单"],
  ["空格（文件中）", "快速查看所选文件"],
  ["⌘↑（文件中）", "前往上一级文件夹"],
  ["⌘C / ⌘V（文件中）", "拷贝 / 粘贴文件"],
  ["F 或绿灯（播放视频时）", "进入或退出全屏"],
  ["⌘W 或红灯（播放视频时）", "停止视频，回到资料库"],
  ["右键视频", "字幕、音轨、速度、选集"],
  ["← / →（播放视频时）", "后退 / 前进 5 秒"],
];

export function HelpView() {
  return (
    <div className="page narrow">
      <header className="page-header">
        <div className="heading">
          <h1 className="large-title">Cove 帮助</h1>
          <p className="page-subtitle">把本机和云端的影片、剧集与音乐整理在一处。</p>
        </div>
      </header>
      <section className="group">
        <h2 className="group-title">开始使用</h2>
        <ol className="group-box help-steps">
          <li className="group-row">
            <span className="glyph blue small">1</span>
            <span className="row-main">
              <span className="row-title">添加存储</span>
              <span className="row-subtitle">点边栏“位置”旁的 +，添加 WebDAV、百度网盘等存储。凭据只保存在钥匙串中。</span>
            </span>
          </li>
          <li className="group-row">
            <span className="glyph purple small">2</span>
            <span className="row-main">
              <span className="row-title">选择文件夹</span>
              <span className="row-subtitle">在“位置”中打开文件夹，点“添加到资料库”选择影视或音乐，子文件夹会一并扫描。</span>
            </span>
          </li>
          <li className="group-row">
            <span className="glyph pink small">3</span>
            <span className="row-main">
              <span className="row-title">开始播放</span>
              <span className="row-subtitle">影视按作品与剧集整理，音乐显示歌词。播放进度会自动保存。</span>
            </span>
          </li>
        </ol>
      </section>
      <section className="group">
        <h2 className="group-title">键盘快捷键</h2>
        <div className="group-box">
          {SHORTCUTS.map(([keys, action]) => (
            <div className="group-row" key={keys}>
              <span className="row-main row-title">{action}</span>
              <kbd className="row-value keys">{keys}</kbd>
            </div>
          ))}
        </div>
        <p className="group-footer">媒体键、AirPods 与“控制中心”中的播放控制同样可用。移除账号或媒体文件夹不会删除存储中的任何文件。</p>
      </section>
    </div>
  );
}
