function Show-ReminderSettings {
    param(
        [System.Windows.Forms.IWin32Window]$Owner,
        [Parameter(Mandatory)][string]$Directory,
        [Parameter(Mandatory)][string]$NodePath,
        [switch]$SmokeTest,
        [string]$ScreenshotPath
    )

    $raw = & $NodePath (Join-Path $Directory 'settings.mjs') get 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($raw | Out-String) }
    $settings = $raw | Out-String | ConvertFrom-Json

    $ink = [System.Drawing.Color]::FromArgb(25, 38, 55)
    $muted = [System.Drawing.Color]::FromArgb(105, 117, 134)
    $surface = [System.Drawing.Color]::FromArgb(247, 248, 250)
    $orange = [System.Drawing.Color]::FromArgb(255, 111, 0)
    $dialog = [System.Windows.Forms.Form]::new()
    $dialog.Text = 'Codex 重置卡提醒设置'
    $appIcon = [System.Drawing.Icon]::new((Join-Path $Directory 'assets\app-icon.ico'))
    $dialog.Icon = $appIcon
    $dialog.ClientSize = [System.Drawing.Size]::new(590, 540)
    $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.StartPosition = if ($Owner) { 'CenterParent' } else { 'CenterScreen' }
    $dialog.MaximizeBox = $false
    $dialog.MinimizeBox = $false
    $dialog.ShowInTaskbar = -not [bool]$Owner
    if (-not $Owner) { $dialog.TopMost = $true }
    $dialog.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 9)
    $dialog.BackColor = [System.Drawing.Color]::White

    $title = [System.Windows.Forms.Label]::new()
    $title.Text = '提醒设置'
    $title.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 18, [System.Drawing.FontStyle]::Bold)
    $title.ForeColor = $ink
    $title.SetBounds(28, 23, 360, 42)
    $dialog.Controls.Add($title)

    $subtitle = [System.Windows.Forms.Label]::new()
    $subtitle.Text = '当前 Codex 账号 · 保存后生效，提醒计划随后更新'
    $subtitle.ForeColor = $muted
    $subtitle.SetBounds(30, 65, 500, 22)
    $dialog.Controls.Add($subtitle)

    $channelTitle = [System.Windows.Forms.Label]::new()
    $channelTitle.Text = '通知渠道'
    $channelTitle.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
    $channelTitle.ForeColor = $ink
    $channelTitle.SetBounds(30, 105, 200, 28)
    $dialog.Controls.Add($channelTitle)

    $channelPanel = [System.Windows.Forms.Panel]::new()
    $channelPanel.BackColor = $surface
    $channelPanel.SetBounds(28, 135, 534, 112)
    $dialog.Controls.Add($channelPanel)

    $desktopBox = [System.Windows.Forms.CheckBox]::new()
    $desktopBox.Text = 'Windows 桌面弹窗'
    $desktopBox.Checked = [bool]$settings.desktopEnabled
    $desktopBox.ForeColor = $ink
    $desktopBox.SetBounds(18, 13, 300, 27)
    $channelPanel.Controls.Add($desktopBox)
    $desktopHint = [System.Windows.Forms.Label]::new()
    $desktopHint.Text = '到期前 7 / 3 / 1 天和延期到点时提醒'
    $desktopHint.ForeColor = $muted
    $desktopHint.SetBounds(39, 39, 440, 20)
    $channelPanel.Controls.Add($desktopHint)

    $feishuBox = [System.Windows.Forms.CheckBox]::new()
    $feishuBox.Text = '飞书机器人私聊'
    $feishuBox.Checked = [bool]$settings.feishuEnabled
    $feishuBox.Enabled = [bool]$settings.feishuConfigured
    $feishuBox.ForeColor = $ink
    $feishuBox.SetBounds(18, 63, 300, 27)
    $channelPanel.Controls.Add($feishuBox)
    $feishuHint = [System.Windows.Forms.Label]::new()
    $feishuHint.Text = if ($settings.feishuConfigured) { '支持卡片内“已使用”和“稍后提醒”' } else { '尚未连接机器人，请运行“开始安装.vbs”配置' }
    $feishuHint.ForeColor = $muted
    $feishuHint.SetBounds(39, 88, 460, 20)
    $channelPanel.Controls.Add($feishuHint)

    $quietTitle = [System.Windows.Forms.Label]::new()
    $quietTitle.Text = '免打扰'
    $quietTitle.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
    $quietTitle.ForeColor = $ink
    $quietTitle.SetBounds(30, 264, 200, 28)
    $dialog.Controls.Add($quietTitle)

    $quietPanel = [System.Windows.Forms.Panel]::new()
    $quietPanel.BackColor = $surface
    $quietPanel.SetBounds(28, 294, 534, 83)
    $dialog.Controls.Add($quietPanel)
    $quietBox = [System.Windows.Forms.CheckBox]::new()
    $quietBox.Text = '在此时间段内延后提醒'
    $quietBox.Checked = [bool]$settings.quietEnabled
    $quietBox.ForeColor = $ink
    $quietBox.SetBounds(18, 11, 260, 27)
    $quietPanel.Controls.Add($quietBox)
    $startPicker = [System.Windows.Forms.DateTimePicker]::new()
    $startPicker.Format = 'Custom'
    $startPicker.CustomFormat = 'HH:mm'
    $startPicker.ShowUpDown = $true
    $startPicker.Value = [DateTime]::Today.Add([TimeSpan]::Parse([string]$settings.quietStart))
    $startPicker.SetBounds(39, 43, 105, 27)
    $quietPanel.Controls.Add($startPicker)
    $toLabel = [System.Windows.Forms.Label]::new()
    $toLabel.Text = '至'
    $toLabel.TextAlign = 'MiddleCenter'
    $toLabel.SetBounds(153, 43, 30, 27)
    $quietPanel.Controls.Add($toLabel)
    $endPicker = [System.Windows.Forms.DateTimePicker]::new()
    $endPicker.Format = 'Custom'
    $endPicker.CustomFormat = 'HH:mm'
    $endPicker.ShowUpDown = $true
    $endPicker.Value = [DateTime]::Today.Add([TimeSpan]::Parse([string]$settings.quietEnd))
    $endPicker.SetBounds(191, 43, 105, 27)
    $quietPanel.Controls.Add($endPicker)
    $quietHint = [System.Windows.Forms.Label]::new()
    $quietHint.Text = '若顺延会错过到期，则按原时间提醒'
    $quietHint.ForeColor = $muted
    $quietHint.SetBounds(315, 46, 205, 23)
    $quietPanel.Controls.Add($quietHint)
    $quietBox.Add_CheckedChanged({
        $startPicker.Enabled = $quietBox.Checked
        $endPicker.Enabled = $quietBox.Checked
    })
    $startPicker.Enabled = $quietBox.Checked
    $endPicker.Enabled = $quietBox.Checked

    $syncTitle = [System.Windows.Forms.Label]::new()
    $syncTitle.Text = '提醒前核对'
    $syncTitle.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
    $syncTitle.ForeColor = $ink
    $syncTitle.SetBounds(30, 393, 200, 28)
    $dialog.Controls.Add($syncTitle)
    $syncPanel = [System.Windows.Forms.Panel]::new()
    $syncPanel.BackColor = $surface
    $syncPanel.SetBounds(28, 423, 534, 62)
    $dialog.Controls.Add($syncPanel)
    $preflightBox = [System.Windows.Forms.CheckBox]::new()
    $preflightBox.Text = '发送前尝试读取 Codex 最新数据'
    $preflightBox.Checked = [bool]$settings.preflightEnabled
    $preflightBox.ForeColor = $ink
    $preflightBox.SetBounds(18, 16, 285, 27)
    $syncPanel.Controls.Add($preflightBox)
    $retryLabel = [System.Windows.Forms.Label]::new()
    $retryLabel.Text = '最短间隔'
    $retryLabel.SetBounds(320, 18, 72, 24)
    $syncPanel.Controls.Add($retryLabel)
    $retryBox = [System.Windows.Forms.NumericUpDown]::new()
    $retryBox.Minimum = 5
    $retryBox.Maximum = 1440
    $retryBox.Increment = 5
    $retryBox.Value = [decimal]$settings.retryMinutes
    $retryBox.SetBounds(394, 15, 75, 28)
    $syncPanel.Controls.Add($retryBox)
    $minuteLabel = [System.Windows.Forms.Label]::new()
    $minuteLabel.Text = '分钟'
    $minuteLabel.SetBounds(477, 18, 47, 24)
    $syncPanel.Controls.Add($minuteLabel)
    $preflightBox.Add_CheckedChanged({ $retryBox.Enabled = $preflightBox.Checked })
    $retryBox.Enabled = $preflightBox.Checked

    $cancelButton = [System.Windows.Forms.Button]::new()
    $cancelButton.Text = '取消'
    $cancelButton.SetBounds(338, 502, 100, 31)
    $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $dialog.Controls.Add($cancelButton)
    $testButton = [System.Windows.Forms.Button]::new()
    $testButton.Text = '测试提醒'
    $testButton.SetBounds(28, 502, 122, 31)
    $dialog.Controls.Add($testButton)
    $testStatus = [System.Windows.Forms.Label]::new()
    $testStatus.ForeColor = $muted
    $testStatus.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
    $testStatus.SetBounds(160, 502, 170, 31)
    $dialog.Controls.Add($testStatus)
    $testTip = [System.Windows.Forms.ToolTip]::new()
    $testTip.SetToolTip($testButton, '按当前勾选的渠道发送仿真提醒，不会操作真实重置卡。')
    $saveButton = [System.Windows.Forms.Button]::new()
    $saveButton.Text = '保存设置'
    $saveButton.BackColor = $orange
    $saveButton.ForeColor = [System.Drawing.Color]::White
    $saveButton.FlatStyle = 'Flat'
    $saveButton.FlatAppearance.BorderSize = 0
    $saveButton.SetBounds(450, 502, 112, 31)
    $dialog.Controls.Add($saveButton)
    $dialog.AcceptButton = $saveButton
    $dialog.CancelButton = $cancelButton
    $dialog.Tag = [pscustomobject]@{ RefreshError = $null; TestProcess = $null;
        TestOutput = $null; TestError = $null }
    $testTimer = [System.Windows.Forms.Timer]::new()
    $testTimer.Interval = 250
    $testTimer.Add_Tick({
        $process = $dialog.Tag.TestProcess
        if (-not $process -or -not $process.HasExited) { return }
        $testTimer.Stop()
        try {
            $output = $dialog.Tag.TestOutput.GetAwaiter().GetResult()
            $errorText = $dialog.Tag.TestError.GetAwaiter().GetResult()
            $result = $output | ConvertFrom-Json
            $sent = @()
            $failed = @()
            foreach ($channel in @('desktop', 'feishu')) {
                $value = $result.$channel
                if ($value -eq 'sent') {
                    $sent += if ($channel -eq 'desktop') { '桌面' } else { '飞书' }
                } elseif ($value) {
                    $failed += "$(if ($channel -eq 'desktop') { '桌面' } else { '飞书' })：$value"
                }
            }
            if ($failed.Count -gt 0 -or $process.ExitCode -ne 0) {
                $testStatus.ForeColor = [System.Drawing.Color]::FromArgb(185, 58, 54)
                $testStatus.Text = '部分渠道测试失败'
                $detail = if ($failed.Count) { $failed -join "`n" } else { $errorText.Trim() }
                [System.Windows.Forms.MessageBox]::Show($dialog, $detail, '测试提醒结果') | Out-Null
            } else {
                $testStatus.ForeColor = [System.Drawing.Color]::FromArgb(30, 130, 82)
                $testStatus.Text = "$($sent -join '、')已发送"
            }
        } catch {
            $testStatus.ForeColor = [System.Drawing.Color]::FromArgb(185, 58, 54)
            $testStatus.Text = '测试结果读取失败'
            [System.Windows.Forms.MessageBox]::Show($dialog, $_.Exception.Message, '测试提醒失败') | Out-Null
        } finally {
            $process.Dispose()
            $dialog.Tag.TestProcess = $null
            $dialog.Tag.TestOutput = $null
            $dialog.Tag.TestError = $null
            $testButton.Enabled = $true
            $testButton.Text = '测试提醒'
        }
    })
    $testButton.Add_Click({
        $channels = @()
        if ($desktopBox.Checked) { $channels += 'desktop' }
        if ($feishuBox.Checked) { $channels += 'feishu' }
        if (-not $channels.Count) {
            [System.Windows.Forms.MessageBox]::Show($dialog, '请先勾选至少一个通知渠道。', '测试提醒') | Out-Null
            return
        }
        try {
            $process = [System.Diagnostics.Process]::new()
            $process.StartInfo.FileName = $NodePath
            $process.StartInfo.ArgumentList.Add((Join-Path $Directory 'test-reminder.mjs'))
            foreach ($channel in $channels) { $process.StartInfo.ArgumentList.Add($channel) }
            $process.StartInfo.UseShellExecute = $false
            $process.StartInfo.CreateNoWindow = $true
            $process.StartInfo.RedirectStandardOutput = $true
            $process.StartInfo.RedirectStandardError = $true
            if (-not $process.Start()) { throw '无法启动测试提醒。' }
            $dialog.Tag.TestProcess = $process
            $dialog.Tag.TestOutput = $process.StandardOutput.ReadToEndAsync()
            $dialog.Tag.TestError = $process.StandardError.ReadToEndAsync()
            $testButton.Enabled = $false
            $testButton.Text = '测试中…'
            $testStatus.ForeColor = $muted
            $testStatus.Text = '正在发送…'
            $testTimer.Start()
        } catch {
            if ($process) { $process.Dispose() }
            [System.Windows.Forms.MessageBox]::Show($dialog, $_.Exception.Message, '测试提醒失败') | Out-Null
        }
    })
    $dialog.Add_FormClosed({
        $testTimer.Stop()
        $testTimer.Dispose()
        $testTip.Dispose()
        if ($dialog.Tag.TestProcess) { $dialog.Tag.TestProcess.Dispose() }
    })
    $saveButton.Add_Click({
        $saveButton.Enabled = $false
        $saveButton.Text = '保存中…'
        $dialog.UseWaitCursor = $true
        $dialog.Refresh()
        $saved = $false
        try {
            $values = @{
                desktopEnabled = [bool]$desktopBox.Checked
                feishuEnabled = [bool]$feishuBox.Checked
                quietEnabled = [bool]$quietBox.Checked
                quietStart = $startPicker.Value.ToString('HH:mm')
                quietEnd = $endPicker.Value.ToString('HH:mm')
                preflightEnabled = [bool]$preflightBox.Checked
                retryMinutes = [int]$retryBox.Value
            }
            $changed = $values.desktopEnabled -ne [bool]$settings.desktopEnabled -or
                $values.feishuEnabled -ne [bool]$settings.feishuEnabled -or
                $values.quietEnabled -ne [bool]$settings.quietEnabled -or
                $values.quietStart -ne [string]$settings.quietStart -or
                $values.quietEnd -ne [string]$settings.quietEnd -or
                $values.preflightEnabled -ne [bool]$settings.preflightEnabled -or
                $values.retryMinutes -ne [int]$settings.retryMinutes
            if (-not $changed) {
                $dialog.DialogResult = [System.Windows.Forms.DialogResult]::OK
                return
            }
            $json = $values | ConvertTo-Json -Compress
            $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
            $output = & $NodePath (Join-Path $Directory 'settings.mjs') apply $encoded 2>&1
            if ($LASTEXITCODE -ne 0) { throw ($output | Out-String) }
            $saved = $true
            $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
            $refreshScript = Join-Path $Directory 'run-refresh-settings.ps1'
            Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-File', ('"{0}"' -f $refreshScript)) -WindowStyle Hidden
            $dialog.DialogResult = [System.Windows.Forms.DialogResult]::OK
        } catch {
            if ($saved) {
                $dialog.Tag.RefreshError = $_.Exception.Message
                $dialog.DialogResult = [System.Windows.Forms.DialogResult]::OK
            } else {
                [System.Windows.Forms.MessageBox]::Show($dialog, $_.Exception.Message, '保存设置失败') | Out-Null
            }
        } finally {
            $dialog.UseWaitCursor = $false
            $saveButton.Text = '保存设置'
            $saveButton.Enabled = $true
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
        if ($dialog.Tag.RefreshError) {
            $messageOwner = if ($Owner) { $Owner } else { $dialog }
            [System.Windows.Forms.MessageBox]::Show($messageOwner, $dialog.Tag.RefreshError, '设置已保存，提醒任务刷新失败') | Out-Null
        }
        return $result
    } finally {
        $dialog.Dispose()
        $appIcon.Dispose()
        if ($Owner -is [System.Windows.Forms.Form] -and -not $Owner.IsDisposed) {
            $Owner.Show()
            $Owner.Activate()
            $Owner.BringToFront()
        }
    }
}
