param([switch]$SmokeTest, [string]$ScreenshotPath)

$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $SmokeTest -and -not $ScreenshotPath) {
    & (Join-Path $directory 'open-manage.ps1')
    return
}
$config = Get-Content -LiteralPath (Join-Path $directory 'config.json') -Raw | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $directory 'settings-ui.ps1')
$null = Show-ReminderSettings -Directory $directory -NodePath $config.nodePath -SmokeTest:$SmokeTest -ScreenshotPath $ScreenshotPath
