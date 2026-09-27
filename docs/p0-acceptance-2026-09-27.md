# 2026-09-27 P0 验收记录

## 范围

功能分支 `feature/cross-platform`、现有草稿 PR #1。本轮实现发送结果、有限失败补发、单账号绑定保护；未合并主分支或发布 Release。

## 隔离验证

以下为 `2.0.0-beta.1` 首轮 P0 验证记录，保留当时的安装包哈希。

- `npm test`：65 项，64 通过，1 项 Unix 监听租约测试在 Windows 跳过。覆盖渠道部分失败、重启恢复、1/5/15 分钟与上限、并发触发、延期、免打扰、新节点、账号切换、网络失败、旧缓存绑定和飞书正式用卡阻断。
- `npm run probe:sqlite`：Electron 37.10.3、内置 SQLite 22.21.1，探针通过。
- `npm run dist:dir`、`npm run verify:package`：Windows 目录包构建和内容检查通过。
- `npm run dist`：生成 116,704,624 字节的 Windows NSIS 安装程序；SHA-256 为 `655290E7492AD9BA5072C65FCCA9395B820FDE0C5A38641985E81756FA2B4A3E`。Windows 验证显示 `NotSigned`，没有宣称签名。
- `node scripts/smoke-packaged.mjs --setup`、常规模式、`--native-dialogs`：Windows 隔离包的安装页、管理页、设置页、桌面演示弹窗、原生关闭和托盘恢复通过。
- 强制 `CODEX_RESET_MONITOR_CORE_MODE=sidecar` 后运行 `--background`：Windows 后台启动和第二实例恢复通过。
- `node scripts/smoke-packaged.mjs --p0`：Windows 隔离包实际点击账号重新核对和失败渠道重试；检查加载态、结果刷新和渲染器错误日志，通过。

所有测试使用临时数据目录、假卡和不存在的 Codex 程序，不读取正式登录凭证，不发送飞书消息，不使用真实重置卡；`dist/qa-screenshots/p0-results.png` 为本机可复查的 UI 截图。

## 2.0.0-beta.2 官方卡范围修正

- 移除界面、IPC 和 CLI 的新增/编辑手动卡及直接标记手动卡入口。卡片资料以 Codex 同步结果为准；保留提醒延期与官方卡使用反馈。
- 旧手动记录继续保存在数据库中，不进入列表或提醒调度；旧飞书消息按钮返回记录已停用，不执行卡片操作。
- `npm test`：66 项，Windows 65 通过、1 项 Unix 专属测试跳过。新增覆盖本地改写被拒绝、官方名称和到期时间不变、旧记录仍保存且不再发送。
- Windows `npm run dist`、`npm run verify:package` 通过。NSIS 安装程序为 116,703,991 字节，SHA-256 为 `8B54B95692912516ED57F60A7F6E3EC896E3E44DA904EA5E79ABD3B3ED85F200`。
- Windows 常规安装包、`--p0`、强制 sidecar 的 `--background` 检查通过；截图位于 `dist/qa-official-only/`。
- 安装包测试使用隔离的模拟 Codex CLI 与官方卡响应，验证新增/编辑 IPC 被拒绝、延期不改变官方资料、账号无法核实则暂停补发、恢复后可重试。模拟 CLI 记录的方法仅允许初始化、账号读取和 Usage 读取，未调用真实服务或正式用卡接口。

## 仍需真实环境验收

- macOS/Linux 的托盘、自启、休眠恢复和安装后升级，仍需对应系统的真实桌面会话。
- Windows 安装包交互验收使用隔离数据目录；正式账号和真实发送不作为自动化验收内容。
- 飞书网络超时后服务端是否已收、以及平台幂等键的实际保留期，需要有权限的测试机器人环境验证。桌面与旧公众号通道在进程崩溃边界不能保证严格一次。
- 同一邮箱下不同工作区若本机 `account/read` 不返回工作区 ID，只能按邮箱保护；需人工核对 Usage。
- macOS 包尚未签名或公证。
