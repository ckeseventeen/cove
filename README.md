# Cove macOS 媒体中心

Cove 是一个本机优先的 macOS 媒体中心，聚合本地磁盘、百度网盘、WebDAV、Google Drive 与 OneDrive。代码内部保留 Nimbus 命名以兼容既有接口。

## 当前实现

- Tauri 2 + React + TypeScript 桌面工程
- macOS 风格的媒体库首屏与 WebDAV 添加流程
- WebDAV `PROPFIND` 连接验证
- 密码写入 macOS Keychain，SQLite 只保存引用
- SQLite WAL 媒体库基础模型
- 非 HTTPS 远程 WebDAV 默认拒绝，本机调试地址除外
- WebDAV 目录递归扫描与常见视频格式识别
- 扫描结果原子写入本地索引并显示在媒体库
- 仅监听 `127.0.0.1` 的短期令牌 HTTP Range 播放代理
- Google Drive API 与 Microsoft Graph（OneDrive）只读扫描、直连播放
- 百度网盘官方 OAuth 登录、Token 自动刷新、视频扫描与直连播放
- 百度网盘目录浏览，可将任意目录配置为影视库或音乐库
- 多账号、多目录媒体来源聚合；每个来源独立增量对账，不再全盘混扫

Google Drive 与 OneDrive 当前使用 OAuth Access Token 接入，令牌存入 macOS Keychain。正式分发前需要分别申请 Google Cloud OAuth Client ID 和 Microsoft Entra 应用，并补全 PKCE 登录及自动刷新。

百度网盘开发时从项目根目录 `.env` 读取 `NIMBUS_BAIDU_APP_KEY`、`NIMBUS_BAIDU_SECRET_KEY` 和 `NIMBUS_BAIDU_REDIRECT_URI`。用户授权产生的 Access Token 与 Refresh Token 只保存在 macOS Keychain。旧版全盘扫描结果不会再直接展示，只有用户明确选择的影视/音乐目录会进入聚合媒体库。阿里云盘仍需开放平台应用资质；夸克未提供公开的个人网盘文件 API，因此不使用 Cookie 抓取方案。

已接入 libmpv 原生视图、悬浮视频控制层、工具栏音乐播放器与歌词、播放进度持久化。FUSE 挂载未实现。

### macOS 原生体验

- 界面跟随系统浅色/深色外观；边栏使用系统 `NSVisualEffectView` 材质，窗口失焦时选中状态变灰。
- 原生菜单栏（Cove、文件、编辑、显示、控制、窗口、帮助）与标准快捷键；右键菜单使用原生 `NSMenu`。
- 媒体键、AirPods 与“控制中心”的“正在播放”（含封面）通过 `MPRemoteCommandCenter` / `MPNowPlayingInfoCenter` 接入。
- 关闭窗口时：播放音乐则隐藏窗口继续播放（同“音乐”App）；播放视频则停止视频回到资料库。退出应用时保存播放进度。
- 文件浏览器采用访达交互：单击选中、双击打开、空格快速查看、⌘↑ 上一级、⌘C/⌘V 拷贝粘贴、返回/前进历史。
- 资料库分为影视、音乐、文档（PDF）；文件浏览器可按种类分组。PDF 在原生 PDFKit 窗口中阅读并记住页码，音乐记住上次的歌曲和位置。
- 播放视频时只有一条简洁的控制条（音量、±10 秒、播放/暂停、进度）；红黄绿灯负责关闭（回到资料库）、最小化与全屏；字幕、音轨、速度、选集在视频右键菜单。

前端结构：`src/app`（窗口外壳、导航历史、资料库数据）、`src/player`（播放状态与音乐/视频界面）、`src/views`（各页面）、`src/ui`（通用控件）、`src/styles`（设计令牌与样式）。

## 开发环境

需要 Node.js 18+、Rust 1.80+ 和完整 Xcode。

当前机器的 Rust 安装在 `~/.cargo/bin`；如果新终端找不到 `cargo`，先执行 `export PATH="$HOME/.cargo/bin:$PATH"`。

若尚未同意 Xcode 许可协议，`git`/`clang` 会报错；可临时使用命令行工具：`export DEVELOPER_DIR=/Library/Developer/CommandLineTools SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`。

```bash
npm install
npm run tauri dev
```

只预览前端：

```bash
npm install
npm run dev
```

## 下一里程碑

1. 完成真实云盘与长时播放集成验收。
2. 增加任务进度、取消和重试，以及音乐标签与本地歌词。


## 验证与打包

```bash
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run bundle:mac
```

构建机需要 libmpv 开发库（默认寻找 `/opt/homebrew`，可用 `NIMBUS_MPV_PREFIX` 指定）。打包脚本收集动态库、修正路径并进行本地签名；正式分发仍需开发者签名、公证及干净机器验收。

普通构建不嵌入 `.env`。仅个人本机使用的构建可显式执行 `npm run bundle:mac:personal`；该产物包含个人开发配置，不应公开分发。百度/TMDB 也可通过运行环境变量提供配置。

`NIMBUS_DATA_DIR` 可指定独立数据库目录，用于隔离测试数据。`NIMBUS_TEST_MEDIA=/绝对路径/文件` 会在启动后通过正常流程打开该本地文件（影音进入播放器，PDF 进入阅读窗口），用于原生自测。

浏览器预览：`npm run dev` 后打开 `/?demo=1` 使用演示数据（含模拟播放器，可验证歌词、待播清单与全屏播放界面）；`/tests/music-layout.html` 会自动播放一首带长歌词的演示歌曲。演示环境不连接云盘，也不播放视频。

个人 Space 定位、功能缺口、已修复问题、流程验收与架构规划见 [最新业务验收报告](docs/PERSONAL-SPACE-ACCEPTANCE.md)。

本轮原生化改造的审查发现、交互变化与验收记录见 [docs/NATIVE-REDESIGN-2026-10-10.md](docs/NATIVE-REDESIGN-2026-10-10.md)，界面精简见 [docs/NATIVE-REDESIGN-2026-10-11-simplify.md](docs/NATIVE-REDESIGN-2026-10-11-simplify.md)，文档分类、PDF 阅读与记忆见 [docs/DOCUMENTS-MEMORY-2026-10-11.md](docs/DOCUMENTS-MEMORY-2026-10-11.md)。
