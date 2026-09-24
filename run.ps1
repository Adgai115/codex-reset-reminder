$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -LiteralPath (Join-Path $directory 'config.json') -Raw | ConvertFrom-Json
$dataDirectory = Join-Path $directory '.state'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$logPath = Join-Path $dataDirectory 'reminder-events.log'
$mutex = [System.Threading.Mutex]::new($false, 'Local\CodexResetCardReminderRun')
$locked = $false
try {
    $locked = $mutex.WaitOne(120000)
    if (-not $locked) { exit 0 }
    $verificationOutput = @(& $config.nodePath (Join-Path $directory 'verify-pending.mjs') --quiet 2>&1)
    $verificationCode = $LASTEXITCODE
    $preflightOutput = @(& $config.nodePath (Join-Path $directory 'preflight-sync.mjs') --quiet 2>&1)
    $preflightCode = $LASTEXITCODE
    $reminderOutput = @(& $config.nodePath (Join-Path $directory 'remind.mjs') --quiet 2>&1)
    $reminderCode = $LASTEXITCODE
    $scheduleOutput = @(& (Join-Path $directory 'schedule-next.ps1') 2>&1)
    $output = @($verificationOutput) + @($preflightOutput) + @($reminderOutput) + @($scheduleOutput)
    $resultCode = if ($verificationCode -ne 0 -or $preflightCode -ne 0 -or $reminderCode -ne 0) { 1 } else { 0 }
    if ($output.Count -gt 0 -or $resultCode -ne 0) {
        "$(Get-Date -Format o) completed verify=$verificationCode preflight=$preflightCode reminder=$reminderCode exit=$resultCode" | Add-Content -LiteralPath $logPath -Encoding utf8
        $output | Add-Content -LiteralPath $logPath -Encoding utf8
    }
    exit $resultCode
} catch {
    "$(Get-Date -Format o) failed: $($_.Exception.Message)" | Add-Content -LiteralPath $logPath -Encoding utf8
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
