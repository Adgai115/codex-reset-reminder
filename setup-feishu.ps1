param(
    [string]$AppId,
    [string]$RecipientId,
    [switch]$SecretFromStdin
)

$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $directory 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw '请先安装本机提醒任务，再连接飞书机器人。' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable
if (-not $config.larkCliScript) { throw '未找到本机 lark-cli，请先安装 lark-cli 后重运行 install.ps1。' }

$AppId = if ($AppId) { $AppId.Trim() } else { (Read-Host '请输入飞书应用 App ID').Trim() }
$RecipientId = if ($RecipientId) { $RecipientId.Trim() } else { (Read-Host '请输入接收人 Open ID（ou_）或 Union ID（on_）').Trim() }
if ($AppId -notmatch '^cli_[A-Za-z0-9]+$') { throw '飞书 App ID 格式不正确，应以 cli_ 开头。' }
if ($RecipientId -notmatch '^(ou_|on_)[A-Za-z0-9]+$') { throw '接收人 ID 格式不正确，应以 ou_ 或 on_ 开头。' }
$profile = if ($config.feishu.userId) { 'codex-reset-monitor-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) }
    else { 'codex-reset-monitor' }
$plaintext = if ($SecretFromStdin) { [Console]::In.ReadLine() } else {
    $secret = Read-Host '请输入飞书机器人 App Secret（输入时隐藏）' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if ([string]::IsNullOrWhiteSpace($plaintext)) { throw '飞书 App Secret 不能为空。' }
try {
    $start = [System.Diagnostics.ProcessStartInfo]::new($config.nodePath)
    foreach ($arg in @($config.larkCliScript, 'config', 'init', '--force-init', '--name', $profile, '--app-id', $AppId, '--app-secret-stdin')) {
        $start.ArgumentList.Add($arg)
    }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($start)
    try {
        $process.StandardInput.WriteLine($plaintext)
        $process.StandardInput.Close()
        $null = $process.StandardOutput.ReadToEnd()
        $null = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw '飞书 CLI 保存机器人配置失败。请检查 App ID 和 Secret。' }
    } finally { $process.Dispose() }
} finally {
    Remove-Variable plaintext -ErrorAction SilentlyContinue
}

$recipientOpenId = $RecipientId
if ($RecipientId.StartsWith('on_')) {
    $lookup = & $config.nodePath $config.larkCliScript contact +get-user --profile $profile --as bot --user-id $RecipientId --user-id-type union_id --json 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) { throw '机器人已配置，但无法从 Union ID 查询 Open ID。请检查读取用户权限和接收人可用范围。' }
    $envelope = $lookup | ConvertFrom-Json
    $recipientOpenId = $envelope.data.user.open_id
    if ($envelope.ok -ne $true -or -not $recipientOpenId -or -not $recipientOpenId.StartsWith('ou_')) { throw '机器人已配置，但未查到可用于私聊的用户 Open ID。' }
}
$verification = & $config.nodePath $config.larkCliScript im +messages-send --profile $profile --as bot `
    --user-id $recipientOpenId --text 'Codex 重置卡提醒已连接。后续到期提醒会发送到此私聊。' --json 2>$null | Out-String
if ($LASTEXITCODE -ne 0) { throw '飞书测试私聊发送失败。请检查 App ID、App Secret、机器人权限和接收人可用范围。' }
try { $verificationResult = $verification | ConvertFrom-Json }
catch { throw '飞书测试私聊返回了无法识别的结果。' }
if ($verificationResult.ok -ne $true -or $verificationResult.data.message_id -notmatch '^om_') {
    throw '飞书未确认测试私聊已发送，原有配置未更改。'
}
$previousConfig = [System.IO.File]::ReadAllBytes($configPath)
$config.feishu = @{ enabled = $true; as = 'bot'; profile = $profile; userId = $recipientOpenId;
    appId = $AppId; recipientId = $RecipientId }
try {
    [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
    & (Get-Command pwsh.exe -ErrorAction Stop).Source -NoProfile -File (Join-Path $directory 'install-callback.ps1')
    if ($LASTEXITCODE -ne 0) { throw '飞书互动监听安装失败。' }
} catch {
    [System.IO.File]::WriteAllBytes($configPath, $previousConfig)
    throw
}
Write-Output '飞书机器人配置完成，测试私聊已发送。到期提醒会由机器人私聊发送给你。'
