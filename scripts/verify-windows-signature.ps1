$ErrorActionPreference = 'Stop'

$version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
$installerName = "Codex.Reset.Reminder.Setup.$version.exe"
$installer = @(Get-ChildItem -LiteralPath 'dist' -File -Filter $installerName)
$application = @(Get-ChildItem -LiteralPath 'dist/win-unpacked' -File -Filter '*.exe')
if ($installer.Count -ne 1 -or $application.Count -ne 1) {
    throw "Expected one Windows installer and one application executable; found $($installer.Count) and $($application.Count)."
}

foreach ($file in @($installer[0], $application[0])) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
        throw "Invalid or missing Authenticode signature: $($file.Name) ($($signature.Status))."
    }
    Write-Output "Verified Authenticode signature: $($file.Name); publisher=$($signature.SignerCertificate.Subject)"
}
