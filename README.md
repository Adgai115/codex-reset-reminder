# Codex 重置卡到期提醒

跨平台桌面应用，管理**多个 Codex 账号**的官方重置卡，在到期前提醒。支持 Windows、macOS 和 Linux；不是 OpenAI 官方产品。

[下载最新版](https://github.com/Adgai115/codex-reset-reminder/releases/latest) · [使用指南](docs/user-guide.md) · [连接与故障处理](docs/user-guide.md#设置与连接修复)

## 快速开始

1. 安装并登录 [Codex CLI](https://github.com/openai/codex)，确认 `codex` 命令可运行。
2. 从发布页下载对应系统的安装包并启动应用。Windows 使用 NSIS 安装程序，macOS 使用 Apple Silicon DMG，Linux 使用 AppImage 或 deb。
3. 在“安装与连接”中核对 Codex 路径与账号，再到“设置 → 提醒”选择桌面提醒、飞书私聊或微信（PushPlus）；添加账号使用“设置 → 账号”。微信接入步骤见[使用指南](docs/user-guide.md#微信pushplus)。

应用会在启动、每 15 分钟及电脑唤醒后自动核对。保持应用运行或收起到托盘，才能收到本机提醒。

## 主要功能

| 功能 | 行为 |
| --- | --- |
| 官方卡片 | 读取 Codex Usage 中的卡片、到期时间和使用状态；不手动新增或编辑卡片 |
| 到期提醒 | 到期前 7 / 3 / 1 天提醒，可延期；桌面、飞书、微信（PushPlus）渠道分别记录发送结果 |
| 个人微信 | 通过 PushPlus 公众号接收所有已开启提醒账号的通知，消息注明账号；仅通知，用卡仍在本机确认 |
| 失败补发 | 只补发失败渠道，遵守免打扰、延期、账号核对和去重规则 |
| 多账号管理 | 添加独立登录账号，切换查看卡片、同步记录和提醒记录；各账号在后台分别同步和提醒 |
| 统一设置 | 一个入口管理提醒与账号；账号修改即时保存，提醒配置点“保存”生效 |
| 账号保护 | 正式用卡始终使用卡片所属账号的会话；单个账号登录失效不影响其他账号 |
| 立即重置 | 显示账号和卡片，用户二次确认后才请求 Codex 正式用卡接口 |
| 更新 | Windows 安装版可在应用内检查、下载并确认原位升级 |

提醒和同步本身不会消耗重置卡。正式用卡只由用户确认触发；更多操作细节见[桌面版使用指南](docs/user-guide.md)。

## 下载与签名

| 平台 | 当前安装包 |
| --- | --- |
| Windows x64 | NSIS 安装程序 |
| macOS Apple Silicon | DMG；暂不提供 Intel 版 |
| Linux amd64 | AppImage、deb |

下载后可用发布页的 `SHA256SUMS.txt` 核对文件。**目前 Windows 包未签名；macOS 包未签名、未公证**，具体版本以发行说明为准。签名配置和验证方式见[发布签名说明](docs/signing.md)。三平台的真实设备验收范围见[平台验收记录](docs/platform-qa.md)。

## 开发

需要 Node.js 24。桌面版使用 Electron 37、Node 核心、SQLite 和原生 HTML/JS。

```bash
npm ci
npm test
npm run probe:sqlite
npm run dist
```

`npm run dist` 构建当前平台的安装包；`npm start` 从源码启动。测试使用隔离数据和模拟依赖，不消耗真实卡片、不发送真实飞书或微信消息、不修改正式配置。项目根目录旧 `config.json` 和 `.state` 可能包含历史正式数据，开发启动应明确指定隔离 profile。

## 仓库目录

| 目录 | 内容 |
| --- | --- |
| `desktop/` · `core/` · `ui/` | 桌面运行时、共享业务逻辑与界面 |
| `legacy/` | 旧版 Windows PowerShell 实现；`legacy/node/` 存放旧版 Node 脚本 |
| `tests/` | 旧版与跨平台核心的集成测试；各模块仍保留就近单元测试 |
| `scripts/` · `examples/` | 构建检查工具与手动演示脚本 |
| `docs/` | [文档目录](docs/README.md)、发布说明和历史验收记录 |

根目录只保留项目元数据和旧版计划任务、快捷方式引用的兼容入口。旧版内部脚本统一放在 `legacy/`，已有安装路径继续可用。旧版说明见[Windows PowerShell 文档](docs/legacy-powershell.md)。

## 许可

[MIT License](LICENSE)。
