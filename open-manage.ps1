$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $directory 'legacy/installation-state.ps1')
if (-not (Test-ReminderInstalled -Directory $directory)) {
    & (Join-Path $directory 'setup.ps1')
    return
}
. (Join-Path $directory 'legacy/window-singleton.ps1')
Open-CodexSingletonWindow -MutexName 'Local\CodexResetCardManageWindow' `
    -WindowTitle 'Codex 重置卡管理' -ScriptPath (Join-Path $directory 'legacy/manage.ps1')
