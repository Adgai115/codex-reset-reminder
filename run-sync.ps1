$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -LiteralPath (Join-Path $directory 'config.json') -Raw | ConvertFrom-Json
$dataDirectory = Join-Path $directory '.state'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$logPath = Join-Path $dataDirectory 'sync.log'
try {
    & $config.nodePath (Join-Path $directory 'sync.mjs') 2>&1 | Set-Content -LiteralPath $logPath -Encoding utf8
    exit $LASTEXITCODE
} catch {
    $_.Exception.Message | Set-Content -LiteralPath $logPath -Encoding utf8
    exit 1
}
