. (Join-Path $PSScriptRoot 'installation-state.ps1')

function Confirm-FeishuReconnect {
    param([System.Windows.Forms.IWin32Window]$Owner)

    $choice = [System.Windows.Forms.Form]::new()
    $choice.Text = '确认重新连接飞书'
    $choice.ClientSize = [System.Drawing.Size]::new(420, 162)
    $choice.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $choice.StartPosition = 'CenterParent'
    $choice.MaximizeBox = $false
    $choice.MinimizeBox = $false
    $choice.ShowInTaskbar = $false
    $choice.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 9)
    $message = [System.Windows.Forms.Label]::new()
    $message.Text = "确定要重新连接飞书机器人吗？`r`n确认后可修改 App ID、接收人 ID 和 App Secret。`r`n保存新配置时会向接收人发送一条测试私聊。"
    $message.SetBounds(24, 22, 380, 82)
    $choice.Controls.Add($message)
    $cancel = [System.Windows.Forms.Button]::new()
    $cancel.Text = '取消'
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancel.SetBounds(205, 113, 90, 32)
    $choice.Controls.Add($cancel)
    $confirm = [System.Windows.Forms.Button]::new()
    $confirm.Text = '确认重新连接'
    $confirm.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $confirm.SetBounds(305, 113, 100, 32)
    $choice.Controls.Add($confirm)
    $choice.AcceptButton = $cancel
    $choice.CancelButton = $cancel
    try { return $choice.ShowDialog($Owner) -eq [System.Windows.Forms.DialogResult]::OK }
    finally { $choice.Dispose() }
}

function Show-ReminderSetup {
    param(
        [System.Windows.Forms.IWin32Window]$Owner,
        [Parameter(Mandatory)][string]$Directory,
        [switch]$SmokeTest,
        [string]$ScreenshotPath
    )

    $dialog = [System.Windows.Forms.Form]::new()
    $dialog.Text = 'Codex 重置卡提醒 · 安装与连接'
    $dialog.Icon = [System.Drawing.Icon]::new((Join-Path $Directory 'assets\app-icon.ico'))
    $dialog.ClientSize = [System.Drawing.Size]::new(620, 465)
    $dialog.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $dialog.StartPosition = if ($Owner) { 'CenterParent' } else { 'CenterScreen' }
    $dialog.MaximizeBox = $false
    $dialog.MinimizeBox = $false
    $dialog.ShowInTaskbar = -not [bool]$Owner
    $dialog.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 9)
    $dialog.BackColor = [System.Drawing.Color]::White
    $ink = [System.Drawing.Color]::FromArgb(25, 38, 55)
    $muted = [System.Drawing.Color]::FromArgb(105, 117, 134)
    $surface = [System.Drawing.Color]::FromArgb(247, 248, 250)

    $title = [System.Windows.Forms.Label]::new()
    $title.Text = '安装与连接'
    $title.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 18, [System.Drawing.FontStyle]::Bold)
    $title.ForeColor = $ink
    $title.SetBounds(28, 20, 400, 42)
    $dialog.Controls.Add($title)
    $intro = [System.Windows.Forms.Label]::new()
    $intro.Text = '先安装本机提醒；需要飞书私聊时，再连接你自己的机器人应用。'
    $intro.ForeColor = $muted
    $intro.SetBounds(30, 64, 560, 24)
    $dialog.Controls.Add($intro)

    $localPanel = [System.Windows.Forms.Panel]::new()
    $localPanel.BackColor = $surface
    $localPanel.SetBounds(28, 104, 564, 101)
    $dialog.Controls.Add($localPanel)
    $localTitle = [System.Windows.Forms.Label]::new()
    $localTitle.Text = '1  Windows 本机提醒'
    $localTitle.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
    $localTitle.SetBounds(16, 12, 245, 27)
    $localPanel.Controls.Add($localTitle)
    $localStatus = [System.Windows.Forms.Label]::new()
    $localStatus.ForeColor = $muted
    $localStatus.SetBounds(16, 42, 370, 23)
    $localPanel.Controls.Add($localStatus)
    $localHint = [System.Windows.Forms.Label]::new()
    $localHint.Text = '安装登录、唤醒、每小时和到期前 7 / 3 / 1 天的提醒任务。'
    $localHint.ForeColor = $muted
    $localHint.SetBounds(16, 69, 530, 22)
    $localPanel.Controls.Add($localHint)
    $localButton = [System.Windows.Forms.Button]::new()
    $localButton.Text = '安装本机提醒'
    $localButton.SetBounds(401, 18, 145, 33)
    $localPanel.Controls.Add($localButton)

    $feishuPanel = [System.Windows.Forms.Panel]::new()
    $feishuPanel.BackColor = $surface
    $feishuPanel.SetBounds(28, 219, 564, 181)
    $dialog.Controls.Add($feishuPanel)
    $feishuTitle = [System.Windows.Forms.Label]::new()
    $feishuTitle.Text = '2  飞书机器人私聊（可选）'
    $feishuTitle.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
    $feishuTitle.SetBounds(16, 10, 300, 27)
    $feishuPanel.Controls.Add($feishuTitle)
    $feishuStatus = [System.Windows.Forms.Label]::new()
    $feishuStatus.ForeColor = $muted
    $feishuStatus.SetBounds(16, 40, 530, 22)
    $feishuPanel.Controls.Add($feishuStatus)
    $appIdLabel = [System.Windows.Forms.Label]::new()
    $appIdLabel.Text = '应用 App ID'
    $appIdLabel.SetBounds(16, 72, 105, 24)
    $feishuPanel.Controls.Add($appIdLabel)
    $appIdBox = [System.Windows.Forms.TextBox]::new()
    $appIdBox.SetBounds(121, 69, 425, 26)
    $feishuPanel.Controls.Add($appIdBox)
    $recipientLabel = [System.Windows.Forms.Label]::new()
    $recipientLabel.Text = '接收人 ID'
    $recipientLabel.SetBounds(16, 105, 105, 24)
    $feishuPanel.Controls.Add($recipientLabel)
    $recipientBox = [System.Windows.Forms.TextBox]::new()
    $recipientBox.SetBounds(121, 102, 425, 26)
    $feishuPanel.Controls.Add($recipientBox)
    $recipientHint = [System.Windows.Forms.Label]::new()
    $recipientHint.Text = '填写 ou_ 开头的 Open ID，或 on_ 开头的 Union ID。'
    $recipientHint.ForeColor = $muted
    $recipientHint.SetBounds(122, 128, 425, 18)
    $feishuPanel.Controls.Add($recipientHint)
    $secretLabel = [System.Windows.Forms.Label]::new()
    $secretLabel.Text = 'App Secret'
    $secretLabel.SetBounds(16, 151, 105, 24)
    $feishuPanel.Controls.Add($secretLabel)
    $secretBox = [System.Windows.Forms.TextBox]::new()
    $secretBox.UseSystemPasswordChar = $true
    $secretBox.SetBounds(121, 148, 280, 26)
    $feishuPanel.Controls.Add($secretBox)
    $feishuButton = [System.Windows.Forms.Button]::new()
    $feishuButton.Text = '连接飞书'
    $feishuButton.SetBounds(412, 146, 134, 30)
    $feishuPanel.Controls.Add($feishuButton)

    $activity = [System.Windows.Forms.Label]::new()
    $activity.ForeColor = $muted
    $activity.SetBounds(30, 417, 460, 26)
    $dialog.Controls.Add($activity)
    $doneButton = [System.Windows.Forms.Button]::new()
    $doneButton.Text = if ($Owner) { '完成' } else { '完成并打开管理' }
    $doneButton.SetBounds($(if ($Owner) { 496 } else { 436 }), 414, $(if ($Owner) { 96 } else { 156 }), 32)
    $doneButton.Enabled = $false
    $doneButton.Add_Click({ $dialog.DialogResult = [System.Windows.Forms.DialogResult]::OK })
    $dialog.Controls.Add($doneButton)

    $dialog.Tag = [pscustomobject]@{ Process = $null; Output = $null; Error = $null; Kind = $null; LocalInstalled = $false; FeishuConfigured = $false; FeishuEditing = $false }
    $setFeishuEditable = {
        param([bool]$Editable)
        $appIdBox.ReadOnly = -not $Editable
        $recipientBox.ReadOnly = -not $Editable
        $secretBox.ReadOnly = -not $Editable
        $appIdBox.TabStop = $Editable
        $recipientBox.TabStop = $Editable
        $secretBox.TabStop = $Editable
        $boxColor = if ($Editable) { [System.Drawing.Color]::White } else { [System.Drawing.Color]::FromArgb(235, 238, 242) }
        $appIdBox.BackColor = $boxColor
        $recipientBox.BackColor = $boxColor
        $secretBox.BackColor = $boxColor
        $recipientHint.Text = if ($Editable) { '填写 ou_ 开头的 Open ID，或 on_ 开头的 Union ID。' }
            else { '配置已锁定；重新连接需再次输入 App Secret。' }
    }
    $refreshStatus = {
        $tasks = @(Get-ScheduledTask -TaskName 'CodexResetCardSync',
            'CodexResetCardExpiryReminder', 'CodexResetCardFeishuActions' -ErrorAction SilentlyContinue)
        $installed = Test-ReminderInstalled -Directory $Directory -Tasks $tasks
        $dialog.Tag.LocalInstalled = $installed
        $doneButton.Enabled = $installed -and -not $dialog.Tag.Process
        $localStatus.Text = if ($installed) { '已安装 · 本地计划任务会在后台运行' } else { '尚未安装' }
        $localStatus.ForeColor = if ($installed) { [System.Drawing.Color]::FromArgb(30, 130, 82) } else { $muted }
        $localButton.Text = if ($installed) { '重新安装 / 修复' } else { '安装本机提醒' }
        $configPath = Join-Path $Directory 'config.json'
        $config = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } else { $null }
        $callback = $tasks | Where-Object TaskName -eq 'CodexResetCardFeishuActions' | Select-Object -First 1
        $configured = [bool]($config.feishu.as -eq 'bot' -and $config.feishu.userId)
        $dialog.Tag.FeishuConfigured = $configured
        $feishuStatus.Text = if ($configured -and -not $config.feishu.enabled) { '已配置 · 飞书通知已关闭，可在提醒设置中开启' }
            elseif ($configured -and $callback.State -eq 'Running') { '已配置 · 飞书互动监听正在运行' }
            elseif ($configured -and $callback) { '已配置 · 飞书互动监听等待启动' }
            elseif ($configured) { '已配置 · 飞书互动监听未安装，请修复本机提醒' }
            elseif (-not $installed) { '安装本机提醒后可连接飞书' }
            elseif (-not $config.larkCliScript) { '未找到 lark-cli，请先安装飞书 CLI 后重新安装本机提醒' }
            else { '尚未连接 · 连接时会发送测试私聊以验证权限' }
        $feishuStatus.ForeColor = if ($configured -and $config.feishu.enabled -and $callback) { [System.Drawing.Color]::FromArgb(30, 130, 82) } else { $muted }
        if ($configured -and -not $dialog.Tag.FeishuEditing) {
            $appIdBox.Text = if ($config.feishu.appId) { [string]$config.feishu.appId } else { '旧版配置未记录 App ID' }
            $recipientBox.Text = if ($config.feishu.recipientId) { [string]$config.feishu.recipientId } else { [string]$config.feishu.userId }
            $secretBox.Clear()
        } elseif (-not $dialog.Tag.FeishuEditing) {
            if ($config.feishu.appId) { $appIdBox.Text = [string]$config.feishu.appId }
            if ($config.feishu.recipientId) { $recipientBox.Text = [string]$config.feishu.recipientId }
        }
        & $setFeishuEditable (-not $configured -or $dialog.Tag.FeishuEditing)
        $feishuButton.Enabled = $installed -and [bool]$config.larkCliScript
        $feishuButton.Text = if ($dialog.Tag.FeishuEditing) { '保存并连接' } elseif ($configured) { '重新连接' } else { '连接飞书' }
    }

    $workTimer = [System.Windows.Forms.Timer]::new()
    $workTimer.Interval = 300
    $workTimer.Add_Tick({
        $process = $dialog.Tag.Process
        if (-not $process -or -not $process.HasExited) { return }
        $workTimer.Stop()
        $kind = $dialog.Tag.Kind
        try {
            $output = $dialog.Tag.Output.GetAwaiter().GetResult()
            $errorText = $dialog.Tag.Error.GetAwaiter().GetResult()
            if ($process.ExitCode -ne 0) {
                $detail = if ($errorText.Trim()) { $errorText.Trim() } else { $output.Trim() }
                if ($detail.Length -gt 900) { $detail = $detail.Substring($detail.Length - 900) }
                throw $(if ($detail) { $detail } else { '安装程序返回失败。' })
            }
            if ($kind -eq 'feishu') { $dialog.Tag.FeishuEditing = $false }
            & $refreshStatus
            $activity.ForeColor = [System.Drawing.Color]::FromArgb(30, 130, 82)
            $activity.Text = if ($kind -eq 'local') { '本机提醒安装完成。' } else { '飞书机器人已连接。' }
            if ($kind -eq 'feishu') { $secretBox.Clear() }
        } catch {
            $activity.ForeColor = [System.Drawing.Color]::FromArgb(185, 58, 54)
            $activity.Text = if ($kind -eq 'local') { '本机提醒安装失败' } else { '飞书连接失败' }
            [System.Windows.Forms.MessageBox]::Show($dialog, $_.Exception.Message, '安装与连接失败') | Out-Null
        } finally {
            $process.Dispose()
            $dialog.Tag.Process = $null
            $dialog.Tag.Output = $null
            $dialog.Tag.Error = $null
            $localButton.Enabled = $true
            if ($kind -ne 'local') { & $refreshStatus }
            $doneButton.Enabled = $dialog.Tag.LocalInstalled
        }
    })
    $startWork = {
        param([string]$Kind)
        $process = $null
        try {
            $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
            $start = [System.Diagnostics.ProcessStartInfo]::new($pwsh)
            foreach ($arg in @('-NoProfile', '-NonInteractive', '-File')) { $start.ArgumentList.Add($arg) }
            $start.ArgumentList.Add((Join-Path $Directory $(if ($Kind -eq 'local') { 'install.ps1' } else { 'setup-feishu.ps1' })))
            if ($Kind -eq 'feishu') {
                $appId = $appIdBox.Text.Trim()
                $recipientId = $recipientBox.Text.Trim()
                if ($appId -notmatch '^cli_[A-Za-z0-9]+$') { throw '请输入 cli_ 开头的应用 App ID。' }
                if ($recipientId -notmatch '^(ou_|on_)[A-Za-z0-9]+$') { throw '请输入 ou_ 或 on_ 开头的接收人 ID。' }
                if ([string]::IsNullOrWhiteSpace($secretBox.Text)) { throw '请输入飞书 App Secret。' }
                foreach ($arg in @('-AppId', $appId, '-RecipientId', $recipientId, '-SecretFromStdin')) { $start.ArgumentList.Add($arg) }
                $start.RedirectStandardInput = $true
            }
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            $process = [System.Diagnostics.Process]::new()
            $process.StartInfo = $start
            if (-not $process.Start()) { throw '无法启动安装程序。' }
            $dialog.Tag.Process = $process
            $dialog.Tag.Output = $process.StandardOutput.ReadToEndAsync()
            $dialog.Tag.Error = $process.StandardError.ReadToEndAsync()
            $dialog.Tag.Kind = $Kind
            if ($Kind -eq 'feishu') {
                $process.StandardInput.WriteLine($secretBox.Text)
                $process.StandardInput.Close()
                $secretBox.Clear()
            }
            $localButton.Enabled = $false
            $feishuButton.Enabled = $false
            $doneButton.Enabled = $false
            $activity.ForeColor = $muted
            $activity.Text = if ($Kind -eq 'local') { '正在安装本机提醒，请稍候…' } else { '正在连接飞书机器人，请稍候…' }
            $workTimer.Start()
        } catch {
            if ($process) { $process.Dispose() }
            [System.Windows.Forms.MessageBox]::Show($dialog, $_.Exception.Message, '无法开始安装') | Out-Null
        }
    }
    $localButton.Add_Click({ & $startWork 'local' })
    $feishuButton.Add_Click({
        if ($dialog.Tag.FeishuConfigured -and -not $dialog.Tag.FeishuEditing) {
            if (-not (Confirm-FeishuReconnect -Owner $dialog)) { return }
            $dialog.Tag.FeishuEditing = $true
            if ($appIdBox.Text -eq '旧版配置未记录 App ID') { $appIdBox.Clear() }
            $secretBox.Clear()
            & $setFeishuEditable $true
            $feishuButton.Text = '保存并连接'
            $activity.Text = '请填写新配置，再点击“保存并连接”。'
            $appIdBox.Focus() | Out-Null
            return
        }
        & $startWork 'feishu'
    })
    $dialog.Add_Shown({ & $refreshStatus })
    $dialog.Add_FormClosing({
        param($sender, $eventArgs)
        if ($dialog.Tag.Process -and -not $dialog.Tag.Process.HasExited) {
            $eventArgs.Cancel = $true
            [System.Windows.Forms.MessageBox]::Show($dialog, '当前步骤正在执行，请等待结果后再关闭。', '安装与连接') | Out-Null
        }
    })
    if ($ScreenshotPath) {
        $dialog.Add_Shown({
            $bitmap = [System.Drawing.Bitmap]::new($dialog.Width, $dialog.Height)
            try {
                $dialog.DrawToBitmap($bitmap, [System.Drawing.Rectangle]::new(0, 0, $dialog.Width, $dialog.Height))
                $bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
            } finally { $bitmap.Dispose(); $dialog.Close() }
        })
    } elseif ($SmokeTest) {
        $dialog.Opacity = 0
        $dialog.Add_Shown({ $dialog.Close() })
    }
    try {
        $result = if ($Owner) { $dialog.ShowDialog($Owner) } else { $dialog.ShowDialog() }
        return $result -eq [System.Windows.Forms.DialogResult]::OK
    } finally {
        $workTimer.Stop()
        $workTimer.Dispose()
        if ($dialog.Tag.Process) { $dialog.Tag.Process.Dispose() }
        $dialog.Icon.Dispose()
        $dialog.Dispose()
    }
}
