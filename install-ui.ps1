$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
if (-not (Test-Path -LiteralPath $desktop -PathType Container)) {
    Write-Warning '找不到当前用户桌面，跳过应用快捷方式。'
    return
}

$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$runner = Join-Path $directory 'run-hidden.vbs'
$entry = Join-Path $directory 'open-manage.ps1'
$arguments = '//B //Nologo "{0}" "{1}" "{2}"' -f $runner, $pwsh, $entry
$oldShortcut = Join-Path $desktop 'Codex 重置卡提醒设置.lnk'
$mainShortcut = Join-Path $desktop 'Codex 重置卡提醒.lnk'
if ((Test-Path -LiteralPath $oldShortcut) -and -not (Test-Path -LiteralPath $mainShortcut)) {
    Move-Item -LiteralPath $oldShortcut -Destination $mainShortcut
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($mainShortcut)
$shortcut.TargetPath = $wscript
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $directory
$shortcut.IconLocation = "$(Join-Path $directory 'assets\app-icon.ico'),0"
$shortcut.Description = '打开 Codex 重置卡管理主页面'
$shortcut.Save()

# Older installations may have a manual launcher task with the former name.
$legacyTask = Get-ScheduledTask -TaskName 'CodexResetCardSettings' -ErrorAction SilentlyContinue
if ($legacyTask) {
    try {
        $action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments
        Set-ScheduledTask -TaskName 'CodexResetCardSettings' -Action $action | Out-Null
    } catch {
        Write-Warning "旧启动任务未能更新：$($_.Exception.Message)"
    }
}
Write-Output "主页面快捷方式：$mainShortcut"
