$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$output = Join-Path (Split-Path -Parent $directory) 'codex-reset-reminder-user.zip'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output }
$zip = [System.IO.Compression.ZipFile]::Open($output, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem -LiteralPath $directory -File -Recurse) {
        $relative = [System.IO.Path]::GetRelativePath($directory, $file.FullName).Replace('\', '/')
        if ($relative -match '^(\.state|node_modules)/') { continue }
        if ($relative -in @('config.json', 'status.json', 'last-run.log')) { continue }
        if ($relative -match '(^|/)([^/]+\.test\.mjs|demo-[^/]+\.mjs)$') { continue }
        if ($relative -in @('build-icon.ps1', 'build-user-package.ps1')) { continue }
        $allowed = $relative -in @('README.md', 'INSTALL.md', 'LICENSE', 'config.example.json') -or
            $relative -match '\.(mjs|ps1|vbs)$' -or $relative -match '^assets/.*\.(ico|png)$'
        if (-not $allowed) { continue }
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $file.FullName, "codex-reset-reminder/$relative",
            [System.IO.Compression.CompressionLevel]::Optimal)
    }
} finally { $zip.Dispose() }
Write-Output "用户安装包：$output"
