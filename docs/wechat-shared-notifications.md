# 微信共用通知（实验）

本阶段让多个本机 agent 和重置卡提醒应用共用一个微信收发入口。只有“微信直连验证”工具保存并使用微信登录凭据；调用方拿到的是独立的本机通知权限文件，不能从中取得微信 Bot Token。消息由微信官方接口传输，无第三方转发平台。微信对话中的 agent 分派尚未实现。

这是开发工具，需要手动启动并启用本机共享服务，不会随正式应用自动启动。当前已发布、已安装的 v2.2.3 不包含此能力。正式提醒应用的实验渠道须由用户在统一“设置”入口选择客户端文件并保存；本文命令不会修改正式配置。

## 接入一个 agent

1. 运行 `npm run probe:wechat`，在验证窗口完成扫码绑定。
2. 启用本机共享服务，为每个 agent 创建单独的客户端，并导出加密的 `.bin` 权限文件。
3. 将该文件保存在本机私人目录中。调用方必须由同一个操作系统用户运行；换电脑或换系统用户须重新导出。每个 agent 使用各自文件，便于单独撤销。
4. 在窗口中查看客户端和消息提交状态。首次确认测试内容后再由用户主动提交测试。

入口只监听 `127.0.0.1` 的随机端口，不向局域网或公网开放；公共发现文件只记录版本和本机端口，不包含权限密钥。权限文件用 Electron 系统凭据保护加密，Node 调用器交由隐藏的 Electron 进程解密。Windows 文件包含 DPAPI 保护的密钥封装，使帮助进程能够使用独立临时 profile 解密；不会复制原浏览器 profile 或导出明文密钥。Windows 下 Node 与帮助进程使用带一次性鉴权的本机回环通信，兼容 Electron 无法可靠接收 stdin 的情形；调用 CLI 的消息仍用 UTF-8 stdin 输入。不要把 `.bin` 文件、微信会话文件或发现目录提交到 Git、上传云端、放进模型提示词或日志中。

## Node 调用

在项目根目录运行以下示例。示例会真正申请发送通知，应在检查内容后由用户主动执行；自动化验证只使用隔离文件和模拟服务。

```js
// agent-notify.mjs
import { spawn } from 'node:child_process';

const child = spawn('node', [
  'E:/docs/codex-reset-reminder/scripts/wechat-official/notify.mjs',
  '--client-file', 'E:/private/wechat-agent-a.bin', '--stdin',
], { windowsHide: true, shell: false, stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(JSON.stringify({
  id: 'agent-a-job-20261003-001',
  title: '任务完成',
  text: '报告已生成，请到本机查看。',
}));
```

`id` 是同一任务的稳定标识，最多 128 个 ASCII 字符，可用字母、数字、点、下划线、冒号和连字符。相同客户端、相同 `id`、相同内容会返回已保存结果；已接受、未知、拒绝的消息不会再次发送。同一 `id` 改写内容会被拒绝。只有确定未调用微信的 `unsent` 才允许用户或业务逻辑再次提交原请求；调用器从不自动重试。

标题最多 100 字符，内容最多 4000 字符，标题与内容合计 UTF-8 最多 8192 字节，整个输入最多 16 KiB。不支持图片、文件或任意收件人。入口为每条通知标注客户端来源，并只发送给已绑定的本人。

## PowerShell 5 中文输入

下面通过 UTF-8 字节直接写入子进程 stdin，避免旧 PowerShell 的管道编码把中文变成问号。消息内容不进入进程参数。

```powershell
$wechatPayload = @{ id = 'agent-a-job-20261003-001'; title = '任务完成'; text = '报告已生成，请到本机查看。' } | ConvertTo-Json -Compress
$wechatStart = New-Object System.Diagnostics.ProcessStartInfo
$wechatStart.FileName = 'node.exe'
$wechatStart.Arguments = '"E:\docs\codex-reset-reminder\scripts\wechat-official\notify.mjs" --client-file "E:\private\wechat-agent-a.bin" --stdin'
$wechatStart.UseShellExecute = $false
$wechatStart.CreateNoWindow = $true
$wechatStart.RedirectStandardInput = $true
$wechatStart.RedirectStandardOutput = $true
$wechatStart.StandardOutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
$wechatProcess = New-Object System.Diagnostics.Process
$wechatProcess.StartInfo = $wechatStart
[void]$wechatProcess.Start()
$wechatBytes = [System.Text.Encoding]::UTF8.GetBytes($wechatPayload)
$wechatProcess.StandardInput.BaseStream.Write($wechatBytes, 0, $wechatBytes.Length)
$wechatProcess.StandardInput.Close()
$wechatProcess.StandardOutput.ReadToEnd()
$wechatProcess.WaitForExit()
$wechatProcess.ExitCode
```

只查询本机状态，无消息发送：

```powershell
node .\scripts\wechat-official\notify.mjs --client-file 'E:\private\wechat-agent-a.bin' --status
```

源码运行默认使用项目安装的 Electron 37。调用方也可加 `--electron-path '安装目录\Codex Reset Reminder.exe'`；被指定的程序必须包含本阶段新增的帮助进程入口，现有 v2.2.3 不支持它。

## 如何解释结果

| state | 含义 | 处理 |
| --- | --- | --- |
| `accepted` | 微信接口接受提交 | 不重复发送；手机是否收到仍需核对 |
| `unknown` | 请求可能已经提交，结果无法确认 | 停止自动补发；人工核对手机 |
| `pending` | 同一请求仍在处理 | 可查询状态，勿创建新 `id` 重发 |
| `rejected` | 服务明确拒绝 | 检查连接；原 `id` 不重发 |
| `unsent` | 确定未发送 | 解决离线、权限、限流等原因后可提交原请求 |

CLI 返回码：接受或状态查询成功为 `0`，确定未发送或拒绝为 `1`，未知或仍在处理为 `2`。输出仅含公共状态，不回显消息正文、凭据或微信登录材料。网关关闭、权限撤销、队列满、凭据无法解密均给出本机错误。默认发送间隔为 15 秒，最多一个发送中、两个等待。来源上限 32 个（包括已撤销来源），通知编号记录上限 1024 条；不清除已完成记录绕过重复检查。到达上限时停止接纳新来源或通知，并保留已有结果。

## 重置卡应用接入

在源码开发版或本阶段构建的候选安装包中，打开“设置 → 提醒 → 微信配置”，选择“本机微信网关（实验）”，选择为重置卡提醒单独导出的加密调用文件，再保存。网关与已授权来源必须保持可用。配置和其他渠道的开关沿用既有保存、草稿与账号隔离规则，既有 PushPlus 凭据仍保留，便于切换渠道。

固定节点与延期提醒发送账号名称、卡片名称和尾号、官方到期时间等必要文字。内部账号与卡片编号只用于生成本机幂等标识，不将完整编号或 Codex 登录凭据发送到微信。相同提醒节点的初次文字保存在本机 SQLite 中，用于确保明确未发送后的重试仍保持同一内容；接口接受不标记为手机已收到。未知结果和明确拒绝均停止该通知的补发；本机明确未发送的情形沿用已有有限补发规则。

2026-10-02，用户确认收到一次“省略上下文”即时测试消息；当次接口结果为未知，因此手机确认是实际送达证据。这只能证明该次测试成功，25 小时后的定时发送仍待验证，不能据此承诺任意时间的主动通知。微信渠道长期限制仍以[腾讯官方协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)及后续实测为准。

隔离验证命令：

```powershell
node --test core/wechat-local-http.test.mjs core/wechat-local-client.test.mjs desktop/wechat-local-client-runtime.test.mjs
```

真实 Electron 解密回环冒烟使用新建临时目录、随机模拟本机权限和仅回环的模拟 HTTP 服务，不读取微信会话，不发送微信消息：

```powershell
.\node_modules\electron\dist\electron.exe .\scripts\wechat-official\client-smoke-main.mjs
```
