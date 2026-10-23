# Cove for Windows（2026-10-23）

Cove 的 Windows 版与 Mac 版共用同一套界面和绝大部分 Rust 代码；只有直接依赖系统的部分各有一份实现。本文记录这些差异、构建方法和尚待在真机上确认的事项。

## 与 Mac 版的差异

| 部分 | macOS | Windows |
|---|---|---|
| 视频画面 | libmpv 通过 OpenGL 画进 NSView（`mpv_view.m`） | libmpv 用 `wid` 画进主窗口里的子窗口（`player_windows.rs`） |
| 播放器控制通道 | Unix socket | 命名管道 `\\.\pipe\cove-mpv-<pid>`，读取用 PeekNamedPipe 实现 1 秒超时 |
| libmpv | 编译时链接 Homebrew 的 libmpv | 运行时从 Cove.exe 旁加载 `libmpv-2.dll`（libloading），构建时不需要导入库 |
| 视频控制层 | 子窗口（addChildWindow） | 由主窗口拥有的透明窗口（GWLP_HWNDPARENT），覆盖客户区 |
| 小窗播放 | `nimbus_window_set_floating` | Tauri 窗口接口：置顶、缩到屏幕工作区右下角 |
| 系统播放控制 | MPRemoteCommandCenter / 控制中心 | SMTC（souvlaki）：媒体键和音量浮窗中的播放器 |
| PDF 阅读 | PDFKit 原生阅读器 | pdf.js 阅读窗口（`src/reader`），记住页码、可选中文字、缩放 |
| SMB | NetFS 挂载到数据目录 | 直接用网络路径 `\\nas\share`，WNetAddConnection2W 登录；只支持 445 端口 |
| 密码与令牌 | 钥匙串 | Windows 凭据管理器；超过约 1000 字符的令牌（OneDrive）分段保存 |
| 菜单 | 系统菜单栏 | 主窗口的菜单栏（文件 / 编辑 / 显示 / 控制 / 帮助），F11 全屏 |
| 关闭窗口 | 播放音乐时隐藏窗口继续播放 | 退出 Cove（Windows 没有 Dock 可以找回窗口），先保存进度 |
| 本地路径 | `/Users/me/影视` | 资料库里写作 `/C:/Users/me/影视`，`/` 列出各个磁盘（`paths.rs`） |

界面上：快捷键显示和按键都把 ⌘ 换成 Ctrl（`src/lib/platform.ts`）；文件中“上一级”用 Alt+↑；字体用 Segoe UI 与微软雅黑；标题栏是系统自带的；“钥匙串”“访达”“这台 Mac”等字样换成 Windows 的说法。

## 构建

正式安装包在 GitHub Actions 的 Windows 机器上构建：`.github/workflows/windows.yml`。在仓库的 Actions 页面选择 **Windows › Run workflow**（或推送 `v*` 标签），完成后在运行记录的 Artifacts 里下载 `Cove-Windows`（`Cove_<版本>_x64-setup.exe`）。推送 `v*` 标签时，安装包还会发布到该标签的 GitHub Release，在仓库首页右侧的 Releases 里直接下载。工作流会：

1. 下载 libmpv（mpv.io 推荐的 shinchiro 构建），核对 SHA-256，放到 `src-tauri/vendor/libmpv-2.dll`；
2. `npm ci`、`npm test`；
3. `npm run tauri build -- --bundles nsis`（`tauri.windows.conf.json` 把 libmpv 放到 Cove.exe 旁边，安装到当前用户，无需管理员权限）；
4. 上传安装包；如果是 `v*` 标签，还会创建该标签的 Release（已有就替换其中的安装包）；
5. 最后跑 `cargo test`，Windows 上的测试失败会显示在记录里，但不影响拿到安装包。

更新 libmpv：在 shinchiro/mpv-winbuild-cmake 的 Releases 里选 `mpv-dev-x86_64-<日期>-git-<提交>.7z`（不带 `v3` 的版本兼容所有 64 位 CPU），同时改工作流里的 `MPV_DEV_URL` 和 `MPV_DEV_SHA256`。

工作流构建的安装包**不含**个人密钥。百度网盘登录需要的开放平台 AppKey / SecretKey 和影视海报需要的 TMDB 令牌，在应用的“设置 › 服务 › 设置…”中填写（添加百度网盘时也会直接要求填写），保存在凭据管理器中；也可以把 `.env` 放在 Cove.exe 旁边（`config.rs`）。

### 在 Mac 上交叉编译（检查和免安装试用）

```bash
rustup target add x86_64-pc-windows-gnu
brew install mingw-w64
cargo check --target x86_64-pc-windows-gnu --manifest-path src-tauri/Cargo.toml
cargo check --tests --target x86_64-pc-windows-gnu --manifest-path src-tauri/Cargo.toml
```

免安装版：先把 libmpv-2.dll 放到 `src-tauri/vendor/`，再

```bash
npm run tauri build -- --target x86_64-pc-windows-gnu --no-bundle
```

把 `src-tauri/target/x86_64-pc-windows-gnu/release/nimbus-desktop.exe`（改名为 Cove.exe）、`libmpv-2.dll` 和同目录的 `WebView2Loader.dll`（MinGW 构建需要它，MSVC 构建不需要）放在一个文件夹里即可运行。Homebrew 的 makensis 3.13 在这台 Mac 上处理任何脚本都会崩溃（bad_alloc），所以安装包只在 Windows 上构建。`Cargo.toml` 去掉了 `cdylib`：MinGW 链接这么大的库会报 “export ordinal too large”，而它只用于 Android。

在 Mac 上试用 pdf.js 阅读器：`NIMBUS_WEB_READER=1` 启动时，PDF 用它打开而不是 PDFKit。

## 要求

- Windows 10 或 11，64 位；WebView2 运行时（Windows 11 自带，Windows 10 安装时会自动下载）。
- libmpv 需要 `vulkan-1.dll`，由显卡驱动提供。缺少时 Cove 会提示更新显卡驱动。
- 安装包没有代码签名，首次运行 SmartScreen 会提示“已保护你的电脑”，选择“更多信息 › 仍要运行”。

## 尚待在 Windows 真机上确认

这些代码在 Mac 上只做了交叉编译和类型检查，没有在 Windows 上运行过：

- 视频画面是否画在主窗口里、控制层是否对齐，以及全屏和小窗播放；
- 媒体键与音量浮窗中的播放控制（SMTC）；
- SMB 登录（WNetAddConnection2W），以及凭据冲突（错误 1219）时的提示；
- 凭据管理器中分段保存的 OneDrive 令牌；
- 菜单栏快捷键（Ctrl+1…5 等）在深色模式下的外观；
- 阅读窗口（pdf.js 部分已在浏览器和 Mac 的 WebView 中验证过：打开到上次的页、选中文字、缩放、页码写回资料库）。
