# Codex 重置卡到期提醒

## 跨平台桌面版（Electron）

首次使用请看 [桌面版使用指南](docs/user-guide.md)：安装连接、查看卡片、延期、提醒设置和退出行为。

跨平台桌面版在 Windows、macOS 和 Linux 上使用同一套 Node 核心与 Electron 界面。应用读取当前登录账号的 Codex Usage，缓存官方重置卡和提醒记录；7 / 3 / 1 天、延期节点以及休眠恢复由应用内调度器处理。桌面和飞书提醒使用一致的“立即重置”按钮，均需二次确认后才请求 Codex 正式用卡接口。提醒本身不调用 Codex 模型，也不消耗模型 Token。

安装前请在本机安装并登录 [Codex CLI](https://github.com/openai/codex)，确保 `codex` 命令可以运行。桌面安装包内含 Node.js 24 sidecar，日常读取优先使用 Electron 内置的 `node:sqlite`；不需要另外安装 Node。开发源码和旧版 PowerShell 工具仍需 Node.js 24。

首次启动先进入“安装与连接”：自动查找 Codex CLI，可手动浏览路径；验证 Usage 读取成功后才进入卡片管理。应用启动即同步，之后每 15 分钟自动刷新，唤醒后自动核对；失败或详情不完整时按 1、5、15 分钟重试，持续故障保持 15 分钟间隔。后台重新核实原账号后自动恢复，旧缓存首次绑定仍需确认。可选择登录系统时自动启动。Windows 机器若检测到旧版计划任务及 `.state\data.db`，会先询问是否迁移卡片、发送记录和飞书配置。数据复制后会核实旧任务已停用；若停用失败，新版不会启动提醒，重启后可继续检查。选择暂不迁移会退出应用，旧版保持运行。桌面版设置保存在系统的 Electron `userData` 目录；开发版仍读取仓库 `config.json` 和 `.state`，便于与旧版共存。

重置卡由 Codex 官方发放。卡片管理只读取官方卡片的名称、编号和到期时间，支持设置或取消延期，以及手动同步 Codex；不提供新增、编辑或手动报告使用。旧版手动记录保留在数据库中，不再列入卡片管理或参与提醒。提醒设置可以开关桌面与飞书渠道、免打扰、提醒前核对、登录自启，并测试桌面弹窗。飞书连接需另行安装本机 `lark-cli`，在设置页输入 App ID、接收人 ID、`lark-cli` 脚本路径和 App Secret；应用先发送测试私聊，成功后才保存连接。密钥由本机 `lark-cli` 保管，不写入应用配置。连接完成后字段锁定；“重新连接”需要二次确认。微信渠道本版不启用。

卡片管理默认显示未过期的“可用卡”；已使用、过期和失效的卡收在“已结束”，有已送达提醒且仍可用的卡可从“已提醒”找回。列表突出单行卡名、编号尾号、到期时间、状态和提醒结果，完整卡号可悬停查看，发送记录和提醒计划收在“详情”；窄窗口横向滚动表格。后台同步、飞书交互、设置保存后会刷新列表。顶部保留简短同步状态和账号，展开后查看完整同步记录与自动重试时间。“稍后提醒”选好即生效，也可从同一菜单取消延期。

应用必须保持运行才能检查提醒。点击关闭会询问“收起到托盘 / 退出应用 / 取消”；最小化直接收起，托盘菜单可以恢复管理窗口。退出应用会停止桌面与飞书提醒。新配置的登录自启会直接进入托盘；再次启动应用会恢复已有窗口。电脑关机期间无法提醒；下次启动会补查尚未过期的节点。Linux 桌面环境对托盘激活的处理不同，单击不一定打开窗口，可以从托盘菜单选择“打开卡片管理”。参见 [Electron Tray 平台说明](https://www.electronjs.org/docs/latest/api/tray)。

设置页默认展开通知和免打扰，连接、诊断、更新和更多设置按需展开。有未保存修改时，取消或关闭会询问是否放弃。所有渠道关闭时会有明确提示，免打扰和核对的附属输入随开关启停；飞书连接单独保存时会保留其他未保存修改。Codex 路径失效后，可在“连接诊断 → 选择 Codex 程序”中修复，验证 Usage 可读后才更新路径。

桌面提醒同轮多卡共用一个窗口，一次显示一张，左右切换，不出现滚动条；显示已核对账号、卡名、编号尾号和到期时间。关闭或重启后，可从管理页或托盘的“已提醒”找回；重新查看不重发消息。Codex 只返回可用数量而未提供逐卡到期详情时，应用保留缓存并自动重试，连接诊断会明确说明。

### 安装与构建

安装页和设置页提供只读 Codex Usage 检查及本地连接诊断。Windows 安装版可在设置页检查、下载并确认原位升级；旧版首次启用此能力仍需手动运行一次安装包。macOS 和 Linux 继续从 GitHub Release 下载对应安装包。三平台的真实设备验收项目见 [platform-qa.md](docs/platform-qa.md)，发布前检查见 [release.md](docs/release.md)。

从 [正式发布页](https://github.com/Adgai115/codex-reset-reminder/releases/latest)下载 Windows x64 NSIS、macOS Apple Silicon (arm64) DMG、Linux amd64 AppImage 或 deb，并用同页的 `SHA256SUMS.txt` 校验。当前没有 Intel macOS 安装包。v2.0.3 的 Windows 和 macOS 包未签名，签名状态以对应版本的发行说明为准。macOS 首次尝试打开后，可在“系统设置 → 隐私与安全性”中选择“仍要打开”，仅在确认下载来源可信时操作。以 [Apple 官方说明](https://support.apple.com/en-au/102445) 为准。Linux AppImage 需要赋予执行权限；deb 可通过系统包管理器安装。若桌面环境隐藏托盘图标，请从应用菜单重新打开程序。

从源码构建时使用 Node.js 24：

```bash
npm ci
npm test
npm run probe:sqlite
npm run dist
```

`npm run dist` 会先把当前平台的 Node.js 24 复制为 sidecar，再用 electron-builder 构建本平台安装包。开发模式运行 `npm start`。GitHub Actions 的 Windows、macOS、Linux matrix 会先跑测试与 Electron SQLite 探针，再分别构建安装包，并用隔离的演示卡启动安装包，检查卡片管理与设置窗口；推送 `v*` tag 后，三个平台全部通过才创建 Release。签名配置与验证方法见 [签名说明](docs/signing.md)。Windows 已在本机完成 2.0.0 安装升级和隔离测试；macOS 和 Linux 尚未实机验收。

### Windows PowerShell 旧版

旧版脚本、计划任务和配置说明见 [Windows PowerShell 旧版文档](docs/legacy-powershell.md)。

## 许可证

本项目采用 [MIT License](LICENSE)。这不是 OpenAI 或飞书的官方应用。
