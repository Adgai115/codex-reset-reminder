$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -LiteralPath (Join-Path $directory 'config.json') -Raw | ConvertFrom-Json
& $config.nodePath (Join-Path $directory 'legacy/node/callback-worker.mjs')
exit $LASTEXITCODE
