$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$secretPath = Join-Path $directory '.state\wechat-appsecret.dpapi'
$ptr = [IntPtr]::Zero
try {
    $config = Get-Content -LiteralPath (Join-Path $directory 'config.json') -Raw | ConvertFrom-Json
    if (-not $config.wechat.enabled -or -not $config.wechat.appId -or -not (Test-Path -LiteralPath $secretPath)) {
        throw '公众号通知尚未完成本机配置。'
    }
    $message = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
    if (-not $message.touser -or -not $message.template_id -or -not $message.data) {
        throw '公众号模板消息参数不完整。'
    }
    $secure = Get-Content -LiteralPath $secretPath -Raw | ConvertTo-SecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plaintext = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    $tokenBody = @{ grant_type = 'client_credential'; appid = $config.wechat.appId; secret = $plaintext } | ConvertTo-Json -Compress
    $token = Invoke-RestMethod -Method Post -Uri 'https://api.weixin.qq.com/cgi-bin/stable_token' -ContentType 'application/json' -Body $tokenBody -TimeoutSec 20
    if (-not $token.access_token) { throw "公众号获取令牌失败，错误码：$([int]$token.errcode)" }
    $uri = 'https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=' + [uri]::EscapeDataString($token.access_token)
    $response = Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json; charset=utf-8' -Body ($message | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec 20
    if ($null -eq $response -or $null -eq $response.errcode) { throw '公众号响应缺少结果码。' }
    if ([int]$response.errcode -ne 0) { throw "公众号发送失败，错误码：$([int]$response.errcode)" }
    if (-not $response.msgid) { throw '公众号响应缺少消息编号。' }
    @{ ok = $true; messageId = $response.msgid } | ConvertTo-Json -Compress
} catch {
    if ($_.Exception.Message -match '^公众号') { [Console]::Error.WriteLine($_.Exception.Message) }
    else { [Console]::Error.WriteLine('公众号请求失败。请检查网络、IP 白名单和本机凭证。') }
    exit 1
} finally {
    if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    Remove-Variable plaintext, tokenBody, token, uri -ErrorAction SilentlyContinue
}
