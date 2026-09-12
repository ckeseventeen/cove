export function HelpView() {
  return (
    <section className="info-page">
      <p className="eyebrow">使用帮助</p>
      <h2>三步建立媒体库</h2>
      <ol className="help-steps">
        <li>
          <strong>1. 连接云盘</strong>
          <span>添加百度网盘并在浏览器完成官方 OAuth 授权，或添加 WebDAV、本地磁盘。凭据安全保存在系统 Keychain 中。</span>
        </li>
        <li>
          <strong>2. 选择具体文件夹</strong>
          <span>在网盘或磁盘目录中，点击目标文件夹右侧设为“影视”或“音乐”，其全部子文件夹会被递归增量扫描。</span>
        </li>
        <li>
          <strong>3. 刷新与播放</strong>
          <span>左侧媒体目录的刷新按钮可随时重新对账；点击媒体卡片即可使用高性能 libmpv 内核硬件解码播放。</span>
        </li>
      </ol>
      <p className="support-note">
        Cove 遵循本地优先与零知识原则。云端文件绝不会因在应用内移除账号或媒体目录而被删除或篡改。
      </p>
    </section>
  );
}
