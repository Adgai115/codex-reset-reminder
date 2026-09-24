$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'CodexResetCardNextReminder'
$mutex = [System.Threading.Mutex]::new($false, 'Local\CodexResetCardSchedule')
$locked = $false
try {
    $locked = $mutex.WaitOne(30000)
    if (-not $locked) { throw '等待下一次提醒计划锁超时。' }
if (-not (Get-ScheduledTask -TaskName 'CodexResetCardExpiryReminder' -ErrorAction SilentlyContinue)) { return }
$config = Get-Content -LiteralPath (Join-Path $directory 'config.json') -Raw | ConvertFrom-Json
$planOutput = & $config.nodePath (Join-Path $directory 'plan-next.mjs')
if ($LASTEXITCODE -ne 0) { throw '计算下一次提醒时间失败。' }
$plan = $planOutput | ConvertFrom-Json
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $plan.nextAt) {
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    return
}

$when = [DateTimeOffset]::FromUnixTimeSeconds([long]$plan.nextAt).LocalDateTime
if ($when -le (Get-Date).AddSeconds(1)) { return }
if ($existing -and $existing.State -ne 'Disabled' -and $existing.Triggers.Count -eq 1) {
    $scheduledAt = [DateTimeOffset]::Parse($existing.Triggers[0].StartBoundary).ToUnixTimeSeconds()
    if ($scheduledAt -eq [long]$plan.nextAt) { return }
}
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$hiddenRunner = Join-Path $directory 'run-hidden.vbs'
$action = New-ScheduledTaskAction -Execute $wscript -Argument ('//B //Nologo "{0}" "{1}" "{2}"' -f $hiddenRunner, $pwsh, (Join-Path $directory 'run.ps1'))
$trigger = New-ScheduledTaskTrigger -Once -At $when
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "下一次 Codex 重置卡检查：$($plan.reason)" -Force | Out-Null
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
