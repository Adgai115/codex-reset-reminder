$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $directory 'config.json'
$stateDirectory = Join-Path $directory '.state'
$secretPath = Join-Path $stateDirectory 'wechat-appsecret.dpapi'

$appId = (Read-Host '公众号 AppID').Trim()
if ($appId -notmatch '^wx[0-9a-fA-F]{16}$') { throw 'AppID 格式无效。' }
$secret = Read-Host '请输入已经轮换的新 AppSecret（隐藏输入）' -AsSecureString
if ($secret.Length -eq 0) { throw 'AppSecret 不能为空。' }

New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$encrypted = ConvertFrom-SecureString -SecureString $secret
[System.IO.File]::WriteAllText($secretPath, $encrypted, [System.Text.UTF8Encoding]::new($false))

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable
$previous = if ($config.wechat -is [hashtable]) { $config.wechat } else { @{} }
$config.wechat = @{
    enabled = $false
    appId = $appId
    openId = $previous.openId
    templateId = $previous.templateId
    fieldMap = if ($previous.fieldMap) { $previous.fieldMap } else { @{} }
}
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
Write-Output '公众号凭证已在本机按当前 Windows 用户加密保存。通知仍处于关闭状态，待确认接口权限、模板和接收人后启用。'
