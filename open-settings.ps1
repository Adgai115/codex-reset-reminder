$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $directory 'open-manage.ps1')
