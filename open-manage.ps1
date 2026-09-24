$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $directory 'installation-state.ps1')
if (-not (Test-ReminderInstalled -Directory $directory)) {
    & (Join-Path $directory 'setup.ps1')
    return
}
. (Join-Path $directory 'window-singleton.ps1')
Open-CodexSingletonWindow -MutexName 'Local\CodexResetCardManageWindow' `
    -WindowTitle 'Codex 重置卡管理' -ScriptPath (Join-Path $directory 'manage.ps1')
