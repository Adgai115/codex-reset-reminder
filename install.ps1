$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $node -p 'process.versions.node'
if ([version]$nodeVersion -lt [version]'24.0.0') { throw '需要 Node.js 24 或更新版本。' }
$codexCommandInfo = Get-Command codex.cmd -ErrorAction SilentlyContinue
if (-not $codexCommandInfo) { throw '需要通过 npm 全局安装的 Codex CLI（npm install -g @openai/codex）。' }
$codexCommand = $codexCommandInfo.Source
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$hiddenRunner = Join-Path $directory 'run-hidden.vbs'
if (-not (Test-Path -LiteralPath $wscript)) { throw '找不到 Windows Script Host，无法安装无命令窗口的计划任务。' }
$larkCommand = (Get-Command lark-cli.cmd -ErrorAction SilentlyContinue).Source
$codexScript = Join-Path (Split-Path -Parent $codexCommand) 'node_modules\@openai\codex\bin\codex.js'
if (-not (Test-Path -LiteralPath $codexScript)) { throw "找不到 Codex CLI 脚本：$codexScript" }

$larkCliScript = if ($larkCommand) { Join-Path (Split-Path -Parent $larkCommand) 'node_modules\@larksuite\cli\scripts\run.js' } else { $null }
if ($larkCliScript -and -not (Test-Path -LiteralPath $larkCliScript)) { $larkCliScript = $null }
$configPath = Join-Path $directory 'config.json'
$config = if (Test-Path -LiteralPath $configPath) {
    Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable
} else {
    Get-Content -LiteralPath (Join-Path $directory 'config.example.json') -Raw | ConvertFrom-Json -AsHashtable
}
$config.nodePath = $node
$config.codexScript = $codexScript
$config.larkCliScript = $larkCliScript
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))

& $node (Join-Path $directory 'sync.mjs')
if ($LASTEXITCODE -ne 0) { Write-Warning '首次 Codex 同步失败；已保存的卡片仍可离线提醒。' }
& $node (Join-Path $directory 'remind.mjs') --dry-run
if ($LASTEXITCODE -ne 0) { throw '本地提醒检查失败；未创建定时任务。' }

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$reminderAction = New-ScheduledTaskAction -Execute $wscript -Argument ('//B //Nologo "{0}" "{1}" "{2}"' -f $hiddenRunner, $pwsh, (Join-Path $directory 'run.ps1'))
$syncAction = New-ScheduledTaskAction -Execute $wscript -Argument ('//B //Nologo "{0}" "{1}" "{2}"' -f $hiddenRunner, $pwsh, (Join-Path $directory 'run-sync.ps1'))
$reminderTriggers = @(
    (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)),
    (New-ScheduledTaskTrigger -AtLogOn -User $user)
)
$syncTriggers = @((New-ScheduledTaskTrigger -Daily -At 08:30), (New-ScheduledTaskTrigger -AtLogOn -User $user))
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'CodexResetCardSync' -Action $syncAction -Trigger $syncTriggers -Principal $principal -Settings $settings -Description '每天及登录时将 Codex 重置卡到期时间同步到本地数据库。' -Force | Out-Null
Register-ScheduledTask -TaskName 'CodexResetCardExpiryReminder' -Action $reminderAction -Trigger $reminderTriggers -Principal $principal -Settings $settings -Description '登录、唤醒及每小时检查缓存；提前 7、3、1 天精确提醒。' -Force | Out-Null

# The ScheduledTasks cmdlets do not expose an event trigger switch.
[xml]$taskXml = Export-ScheduledTask -TaskName 'CodexResetCardExpiryReminder'
$namespace = [System.Xml.XmlNamespaceManager]::new($taskXml.NameTable)
$namespace.AddNamespace('t', $taskXml.DocumentElement.NamespaceURI)
$triggerList = $taskXml.SelectSingleNode('/t:Task/t:Triggers', $namespace)
$eventTrigger = $taskXml.CreateElement('EventTrigger', $taskXml.DocumentElement.NamespaceURI)
$enabled = $taskXml.CreateElement('Enabled', $taskXml.DocumentElement.NamespaceURI)
$enabled.InnerText = 'true'
$subscription = $taskXml.CreateElement('Subscription', $taskXml.DocumentElement.NamespaceURI)
$subscription.InnerText = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name=''Microsoft-Windows-Power-Troubleshooter''] and EventID=1]]</Select><Select Path="System">*[System[Provider[@Name=''Microsoft-Windows-Kernel-Power''] and EventID=107]]</Select></Query></QueryList>'
[void]$eventTrigger.AppendChild($enabled)
[void]$eventTrigger.AppendChild($subscription)
[void]$triggerList.AppendChild($eventTrigger)
Register-ScheduledTask -TaskName 'CodexResetCardExpiryReminder' -Xml $taskXml.OuterXml -Force | Out-Null
& (Join-Path $directory 'schedule-next.ps1')
& (Join-Path $directory 'install-ui.ps1')
if ($config.feishu.enabled) {
    $callbackTask = Get-ScheduledTask -TaskName 'CodexResetCardFeishuActions' -ErrorAction SilentlyContinue
    if (-not $callbackTask) { & $pwsh -NoProfile -File (Join-Path $directory 'install-callback.ps1') }
    elseif ($callbackTask.State -ne 'Running') { Start-ScheduledTask -TaskName 'CodexResetCardFeishuActions' }
} else {
    $callbackTask = Get-ScheduledTask -TaskName 'CodexResetCardFeishuActions' -ErrorAction SilentlyContinue
    if ($callbackTask) {
        if ($callbackTask.State -eq 'Running') { Stop-ScheduledTask -TaskName 'CodexResetCardFeishuActions' }
        Unregister-ScheduledTask -TaskName 'CodexResetCardFeishuActions' -Confirm:$false
    }
}

Write-Output '已安装纯本地 Codex 重置卡提醒。同步 08:30；精确节点、唤醒、每小时及登录时检查。'
Write-Output '任务名称：CodexResetCardSync、CodexResetCardExpiryReminder、CodexResetCardNextReminder（有待提醒节点时）'
if ($config.feishu.enabled) { Write-Output '飞书互动任务：CodexResetCardFeishuActions' }
Write-Output "数据目录：$(Join-Path $directory '.state')"
if (-not $larkCliScript) { Write-Warning '没有找到 lark-cli；飞书发送需要安装该 CLI。' }
