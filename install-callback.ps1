$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -LiteralPath (Join-Path $directory 'config.json') -Raw | ConvertFrom-Json
if (-not $config.feishu.enabled -or -not $config.feishu.userId) { throw '飞书机器人私聊尚未配置。' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$hiddenRunner = Join-Path $directory 'run-hidden.vbs'
if (-not (Test-Path -LiteralPath $wscript)) { throw '找不到 Windows Script Host，无法安装无命令窗口的监听任务。' }
$action = New-ScheduledTaskAction -Execute $wscript -Argument ('//B //Nologo "{0}" "{1}" "{2}"' -f $hiddenRunner, $pwsh, (Join-Path $directory 'run-callback.ps1'))
$trigger = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $user),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 15))
)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'CodexResetCardFeishuActions' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '本机监听飞书重置卡按钮操作，在二次确认后处理用卡和稍后提醒。' -Force | Out-Null
$registered = Get-ScheduledTask -TaskName 'CodexResetCardFeishuActions'
if ($registered.State -eq 'Running') { Stop-ScheduledTask -TaskName 'CodexResetCardFeishuActions' }
. (Join-Path $directory 'callback-process.ps1')
Stop-ReminderCallbackWorker -Directory $directory
Start-ScheduledTask -TaskName 'CodexResetCardFeishuActions'
Write-Output '飞书卡片操作监听已安装并启动。'
