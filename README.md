# Codex 重置卡到期提醒（Windows 本地版）

这是非官方的 Windows 本地工具，使用已登录的 Codex CLI 读取和使用 [Banked Reset](https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work)。它依赖 Codex App Server 的用量与用卡方法；Codex 更新后，这些方法可能变化。请以 Codex **Settings → Usage** 显示的卡片和到期时间为准。项目不会把登录凭据上传到自己的服务器。

本机程序将 Codex 重置卡到期数据保存在安装目录下的 `.state\data.db`。每天 08:30 及登录 Windows 时尝试同步 Codex；7、3、1 天及用户延期的下一节点登记一次性计划任务，另在登录、系统唤醒和每小时补查。只有确有尚未发送的 Codex 卡片提醒，且最近 60 分钟没有尝试同步时，才会在提醒前额外核对一次；读取超时或失败仍从**本地缓存**提醒。没有待发送提醒或待核实的使用反馈时，普通补查不启动 Codex。旧飞书消息的“已使用”反馈及结果不明的用卡请求会在最早 10 分钟后读取 Codex 核验；网络失败时由每小时检查重试。Codex 未登录、未启动或 OpenAI 暂时不可达时，已经缓存的卡片仍可触发桌面弹窗。电脑关机时无法通知，开机登录后会在卡片到期前补提醒。

本地数据包括卡片编号、名称、到期时间、最近同步的可用数量、用户反馈、延期时间和发送记录。Codex 返回不完整详情或同步失败时保留旧缓存；完整同步确认卡片不再可用时停止后续提醒。飞书通过**本机** `lark-cli` 发送；电脑断网时桌面提醒继续，飞书发送失败会在下次运行时重试。

## 首次安装与连接

新用户在 Windows 上双击 `开始安装.vbs`，先进入可视化初始化窗口。点击“安装本机提醒”，程序会配置 Codex 数据路径、桌面快捷方式及登录、唤醒、每小时和精确提醒计划任务；再按需连接飞书机器人，填写应用 App ID、接收人 Open ID（`ou_`）或 Union ID（`on_`），以及隐藏输入的 App Secret。只有本机提醒安装完成，“完成并打开管理”才可点击；点击后才进入卡片管理主页面。连接飞书时会先发送一条测试私聊，确认发送成功才保存配置并锁定输入框；点击“重新连接”并二次确认后才能修改，再点击“保存并连接”生效。取消确认不会更改配置。密钥通过进程标准输入传给本机飞书 CLI，不写进命令行或 `config.json`。飞书连接是可选的，Windows 本地提醒可以独立运行。后续若要修复安装或更换飞书应用，重新运行安装目录中的 `开始安装.vbs`；“提醒设置”中的“测试提醒”可验证已勾选的通知渠道。

安装前需要 Windows、PowerShell 7、Node.js 24 和[通过 npm 全局安装的 Codex CLI](https://github.com/openai/codex/blob/main/README.md)（`npm install -g @openai/codex`）；确保 Codex CLI 已登录。使用飞书时还需要通过 npm 安装、可从命令行运行的 `lark-cli`。安装目录应长期保留且当前用户可写，不要放在 `Program Files` 等受保护目录。如果缺少依赖或安装失败，初始化窗口会显示具体错误。分发给其他用户时，运行 `build-user-package.ps1` 生成干净安装包，内含 `INSTALL.md` 与 `config.example.json`，不包含当前用户的 `config.json`、`.state` 数据库或日志。以下命令均在项目目录执行。

也可用命令行执行本机安装：

```powershell
pwsh -NoProfile -File .\install.ps1
```

安装会做一次同步并注册当前用户的 Windows 计划任务：

| 任务 | 时间 | 行为 |
|---|---|---|
| `CodexResetCardSync` | 08:30、登录时 | 从 Codex 读取卡片并更新 SQLite |
| `CodexResetCardExpiryReminder` | 每小时、登录及系统唤醒时 | 核验到期的使用反馈，并从缓存补发提醒 |
| `CodexResetCardNextReminder` | 最近一个 7/3/1 天、延期或待核验节点 | 准点运行一次；节点变化后自动重排 |
| `CodexResetCardFeishuActions` | 配置飞书后，登录时启动并持续监听 | 处理飞书卡片的“立即使用”、延期和核实按钮 |

计划任务通过隐藏启动器运行，飞书按钮处理和 Codex 查询也直接启动原生程序；正常运行时只显示设计好的桌面提醒，不显示命令窗口。飞书交互监听使用本机独占地址防止多个实例同时处理按钮，每 15 分钟的任务触发负责在进程意外退出后重新启动。计划任务允许电池供电和错过计划时间后补运行。必须登录到 Windows 桌面才能看见交互弹窗；关机期间无法执行本机或飞书通知。提醒按卡片编号、到期时间、7/3/1 天节点和渠道去重；无新提醒时不写日志。

## 卡片管理主页面

从桌面快捷方式 **Codex 重置卡提醒** 打开应用，首先显示卡片管理。选中卡片后可查看下次提醒时间、待补发状态或延期目标；“提醒时间”可选择 1 天后、3 天后、明天 10:00，也可取消已有延期，官方到期时间不变。窗口还可查看上次同步状态并立即同步 Codex；同步期间按钮显示“同步中…”，完成后刷新卡片并显示结果。点击右上角关闭按钮可选择收起到托盘、退出管理窗口或取消。最小化主窗口后进入通知区域；左键单击托盘图标恢复卡片管理。右键菜单显示本地可用数量、最近到期时间和上次核对结果，可打开卡片管理、提醒设置或启动同步。托盘状态只读取本地数据库；退出管理窗口不会停止到期提醒或飞书监听计划任务。

## 提醒设置与后续扩展

打开管理窗口并点击右上角 **提醒设置**，可直接切换 Windows 弹窗、飞书私聊、免打扰和提醒前核对。设置页的“测试提醒”会按当前勾选的渠道发送仿真消息；不会读取或使用真实重置卡，也不会写入正式卡片和发送记录。旧版设置入口现在也会打开卡片管理主窗口：

```powershell
pwsh -NoProfile -File .\open-settings.ps1
```

点击“保存设置”会立即更新 `config.json` 并关闭设置窗口；若设置有变化，程序会在后台重排下次提醒，并按飞书开关启停互动监听任务，无需重新安装整个程序。后台结果记录在 `.state\settings-refresh.log`，失败时会显示警告。未修改设置时直接关闭窗口，不重复刷新任务。设置保存时保留飞书机器人身份和其他渠道配置。关掉某个渠道不会清除其他渠道的发送记录。微信目前仍关闭，暂不显示在设置面板中。

“提醒设置”作为卡片管理主窗口的次级对话框打开，保存或取消后关闭设置并返回卡片管理。主窗口、桌面快捷方式和托盘使用 `assets\app-icon.ico`。旧版手动启动任务 `CodexResetCardSettings` 若存在，也会打开卡片管理主页面。

默认免打扰时间为本机时间 **22:00 至次日 09:00**。落在此时段内的固定节点或延期提醒会在 09:00 发送；如果延后会越过卡片到期时间，则仍按原时间提醒。提醒前核对的最短间隔默认 60 分钟；关闭后仍保留每天 08:30 的同步。飞书卡片和桌面弹窗会显示最近核对时间，超过 24 小时会提示数据可能已过时。

当前数据库只支持**一个 Codex 账号**。增加多账号前必须把账号标识纳入卡片主键、同步记录、发送去重和飞书按钮映射；现有账号数据需要迁移，不能只在配置文件里增加第二组登录信息。提醒时间和渠道开关已独立在 `reminder-policy.mjs`，届时可以给每个账号配置渠道，而不会改动 7/3/1 天规则。

## 配置飞书机器人私聊

本机已安装 `lark-cli` 时，运行：

```powershell
pwsh -NoProfile -File .\setup-feishu.ps1
```

脚本会提示输入应用 App ID、接收人 Open ID 或 Union ID，并**在本机隐藏输入**机器人 App Secret；也可在可视化初始化面板中填写。使用 Union ID 时会查询此应用专属的 Open ID，并把非密钥的发送设置写入 `config.json`。密钥由飞书 CLI 的本机凭据存储管理，不写入项目或日志。机器人需具备向目标用户发送私聊消息的权限和可用范围，不更换全局默认 profile。若 Union ID 查询因权限失败，可在赋权后重运行，或改填应用专属 Open ID。

飞书提醒使用 Card 2.0，展示卡片名称、编号、官方到期时间、剩余天数和最近同步的可用数量。新发送的 Codex 卡片主按钮为 **“立即使用”**，点击后飞书先弹出二次确认；确认后本机才调用 Codex 正式用卡接口。Codex 返回成功时更新本地状态并显示最新用量；若没有符合条件的用量窗口，卡片仍可用。若请求结果不明确，保留卡片并在至少 10 分钟后自动核验。旧飞书消息中的“确认使用”或“已使用”按钮仍只记录使用反馈，避免历史消息突然变成直接用卡。手动录入卡片的按钮为“标记已使用”，只更新本地状态。

“稍后提醒”提供 **1 天后、3 天后、明天 10:00** 三个不晚于到期时间的选项。延期只修改下一次提醒时间，不修改官方 `expiresAt`；落在延期期间的固定 7/3/1 天节点会跳过，延期后的固定节点照常提醒。桌面弹窗只提供“打开 Codex”和相同的延期选项。

飞书按钮回调由本机计划任务 `CodexResetCardFeishuActions` 处理。配置完成后可运行 `node .\demo-feishu.mjs` 发送安全仿真卡。`node .\demo-interactive.mjs --real` 会向真实 Codex 卡片发送交互提醒；这张卡的“立即使用”经二次确认后会正式调用 Codex。这两个演示脚本不会被 `node --test` 自动执行。

## 自有微信公众号通知（默认关闭）

公众号通知复用 7/3/1 天节点、延期和去重规则，只负责单向提醒；“已使用”和“稍后提醒”继续使用飞书卡片。需要在公众号后台确认账号具有合适的模板消息接口权限、选定符合平台规则的模板，并取得接收人的公众号 OpenID。公众号 API 可能要求配置本机出口 IP 白名单；请以账号后台显示的要求为准。

若 AppSecret 曾出现在聊天或日志里，先在公众号后台轮换。之后在本机运行 `pwsh -NoProfile -File .\setup-wechat.ps1`，隐藏输入**新** AppSecret；脚本只把当前 Windows 用户可解密的凭证保存为 `.state\wechat-appsecret.dpapi`，不会把明文写入 `config.json`。此时微信通知仍保持关闭。待确认模板字段后，在 `config.json` 的 `wechat` 中填写 `openId`、`templateId`、`fieldMap` 并将 `enabled` 设为 `true`，才会开始发送。

`fieldMap` 的键必须与公众号模板中的字段键完全一致，值从 `cardName`、`cardId`、`expiresAt`、`remainingDays`、`availableCount` 中选。例如模板确有 `thing1` 和 `time2` 两个字段时可配置：`{"thing1":"cardName","time2":"expiresAt"}`。程序仅在微信接口返回成功时记录该渠道已发送；失败会由下次本地检查重试。微信 API 调用不使用 Codex 模型 Token；电脑关机或本机无法访问微信接口时无法即时发送。

## 查看与手动维护卡片

打开主页面：

```powershell
pwsh -NoProfile -File .\open-manage.ps1
```

窗口可查看卡片、上次同步状态和下次提醒，并可调整提醒时间或立即同步 Codex。桌面提醒只打开 Codex 或安排稍后提醒；新飞书卡片的“立即使用”经二次确认后调用正式用卡接口。手动卡片仍可通过以下命令行维护：

也可用命令行：

```powershell
node .\cards.mjs list
node .\cards.mjs add "备用重置卡" "2026-10-01T18:00"
node .\cards.mjs edit "manual:..." "备用重置卡" "2026-10-02T18:00"
node .\cards.mjs used "manual:..."
node .\cards.mjs report-used "RateLimitResetCredit_..."
node .\cards.mjs options "RateLimitResetCredit_..."
node .\cards.mjs later "RateLimitResetCredit_..." 1d
node .\cards.mjs unsnooze "RateLimitResetCredit_..."
```

到期时间使用电脑的本地时区。手动卡片的编号由程序生成。

## 检查与测试

```powershell
node .\sync.mjs
node .\remind.mjs --dry-run
node .\check.mjs --test-notification
node --test .\*.test.mjs
```

仿真弹窗使用虚构卡片，不调用真实用卡接口，也不会发送飞书。`sync.log` 和 `reminder-events.log` 位于安装目录的 `.state\`。数据库中的 `reminder_deliveries` 对卡片、到期时间、提醒节点、渠道分别去重。Codex 桌面端会映射 `%LOCALAPPDATA%`，所以状态文件使用项目目录，确保交互命令与 Windows 计划任务读写同一份数据。

卸载计划任务：

```powershell
Unregister-ScheduledTask -TaskName CodexResetCardSync -Confirm:$false
Unregister-ScheduledTask -TaskName CodexResetCardExpiryReminder -Confirm:$false
Unregister-ScheduledTask -TaskName CodexResetCardNextReminder -Confirm:$false
Unregister-ScheduledTask -TaskName CodexResetCardFeishuActions -Confirm:$false
```

## 许可证

本项目采用 [MIT License](LICENSE)。这不是 OpenAI 或飞书的官方应用。
