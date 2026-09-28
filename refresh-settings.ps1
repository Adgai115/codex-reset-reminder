$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -LiteralPath (Join-Path $directory 'config.json') -Raw | ConvertFrom-Json

& (Join-Path $directory 'schedule-next.ps1')

$taskName = 'CodexResetCardFeishuActions'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($config.feishu.enabled) {
    if (-not $config.feishu.userId -or $config.feishu.as -ne 'bot') {
        throw '飞书机器人私聊尚未配置。'
    }
    if (-not $task) {
        & (Join-Path $directory 'install-callback.ps1')
    } elseif ($task.State -ne 'Running') {
        Start-ScheduledTask -TaskName $taskName
    }
} else {
    if ($task) {
        if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    # Task Scheduler may leave the Node child alive after stopping its wrapper.
    . (Join-Path $directory 'callback-process.ps1')
    Stop-ReminderCallbackWorker -Directory $directory
}
