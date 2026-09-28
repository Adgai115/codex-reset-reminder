$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $PSScriptRoot
$output = Join-Path (Split-Path -Parent $directory) 'codex-reset-reminder-user.zip'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output }
$zip = [System.IO.Compression.ZipFile]::Open($output, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem -LiteralPath $directory -File -Recurse) {
        $relative = $file.FullName.Substring($directory.Length + 1).Replace('\', '/')
        if ($relative -match '^(\.git|\.github|\.state|node_modules|vendor-node|dist|desktop|ui|scripts|tests|examples)/') { continue }
        if ($relative -in @('config.json', 'status.json', 'last-run.log')) { continue }
        if ($relative -match '(^|/)[^/]+\.test\.mjs$') { continue }
        $allowed = $relative -in @('README.md', 'INSTALL.md', 'LICENSE', 'config.example.json',
            'docs/README.md', 'docs/user-guide.md', 'docs/legacy-powershell.md',
            'docs/platform-qa.md', 'docs/release.md', 'docs/signing.md') -or
            $relative -match '\.(mjs|ps1|vbs)$' -or $relative -match '^assets/.*\.(ico|png)$'
        if (-not $allowed) { continue }
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $file.FullName, "codex-reset-reminder/$relative",
            [System.IO.Compression.CompressionLevel]::Optimal)
    }
} finally { $zip.Dispose() }
Write-Output "用户安装包：$output"
