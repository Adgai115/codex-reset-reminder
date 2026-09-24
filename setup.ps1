param([switch]$SmokeTest, [string]$ScreenshotPath)

$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $directory 'setup-ui.ps1')
$completed = Show-ReminderSetup -Directory $directory -SmokeTest:$SmokeTest -ScreenshotPath $ScreenshotPath
if ($completed -and -not $SmokeTest -and -not $ScreenshotPath) {
    & (Join-Path $directory 'open-manage.ps1')
}
