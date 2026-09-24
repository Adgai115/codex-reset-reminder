$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$stateDirectory = Join-Path $directory '.state'
$logPath = Join-Path $stateDirectory 'settings-refresh.log'
$mutex = [System.Threading.Mutex]::new($false, 'Local\CodexResetCardSettingsRefresh')
$locked = $false
$errorMessage = $null
try {
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    $locked = $mutex.WaitOne(30000)
    if (-not $locked) { throw '等待设置刷新任务超时。' }
    & (Join-Path $directory 'refresh-settings.ps1')
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 设置已保存，提醒计划更新完成。" |
        Set-Content -LiteralPath $logPath -Encoding utf8
} catch {
    $errorMessage = $_.Exception.Message
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 提醒计划更新失败：$errorMessage" |
        Set-Content -LiteralPath $logPath -Encoding utf8
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
if ($errorMessage) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "设置已保存，但提醒计划更新失败：$errorMessage`n详情见 $logPath",
        'Codex 重置卡提醒设置',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    exit 1
}
