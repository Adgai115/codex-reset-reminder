function Get-ReminderTrayStatus {
    param([string]$Directory, [string]$NodePath)

    $raw = & $NodePath (Join-Path $Directory 'cards.mjs') list 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($raw | Out-String) }
    $data = $raw | Out-String | ConvertFrom-Json
    $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    $active = @($data.cards | Where-Object { $_.status -eq 'available' -and [long]$_.expiresAt -gt $now } | Sort-Object expiresAt)
    $nextExpiry = if ($active.Count -gt 0) {
        [DateTimeOffset]::FromUnixTimeSeconds([long]$active[0].expiresAt).LocalDateTime.ToString('MM-dd HH:mm')
    } else { '暂无' }
    $lastSync = if ($data.latestSync -and $data.latestSync.checkedAt) {
        $time = [DateTimeOffset]::FromUnixTimeSeconds([long]$data.latestSync.checkedAt).LocalDateTime.ToString('MM-dd HH:mm')
        $outcome = switch ([string]$data.latestSync.outcome) {
            'complete' { '成功' }
            'partial' { '详情不完整' }
            'failed' { '失败' }
            default { '状态未知' }
        }
        "$time · $outcome"
    } else { '尚未同步' }

    return [pscustomobject]@{ Count = $active.Count; NextExpiry = $nextExpiry; LastSync = $lastSync }
}

function Show-MainCloseChoice {
    param([System.Windows.Forms.Form]$Owner, [System.Drawing.Icon]$AppIcon)

    $dialog = [System.Windows.Forms.Form]::new()
    $dialog.Text = '关闭卡片管理'
    $dialog.Icon = $AppIcon
    $dialog.Size = [System.Drawing.Size]::new(430, 190)
    $dialog.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $dialog.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterParent
    $dialog.MinimizeBox = $false
    $dialog.MaximizeBox = $false
    $dialog.ShowInTaskbar = $false
    $dialog.Font = $Owner.Font

    $message = [System.Windows.Forms.Label]::new()
    $message.Text = '关闭卡片管理窗口后，要继续在托盘中保留窗口吗？'
    $message.SetBounds(22, 22, 385, 28)
    $dialog.Controls.Add($message)
    $note = [System.Windows.Forms.Label]::new()
    $note.Text = '退出管理窗口也不会停止已安装的到期提醒任务。'
    $note.ForeColor = [System.Drawing.Color]::FromArgb(98, 107, 124)
    $note.SetBounds(22, 55, 385, 24)
    $dialog.Controls.Add($note)

    $trayButton = [System.Windows.Forms.Button]::new()
    $trayButton.Text = '收起到托盘'
    $trayButton.SetBounds(22, 105, 130, 32)
    $trayButton.DialogResult = [System.Windows.Forms.DialogResult]::Yes
    $dialog.Controls.Add($trayButton)
    $closeButton = [System.Windows.Forms.Button]::new()
    $closeButton.Text = '退出管理窗口'
    $closeButton.SetBounds(161, 105, 140, 32)
    $closeButton.DialogResult = [System.Windows.Forms.DialogResult]::No
    $dialog.Controls.Add($closeButton)
    $cancelButton = [System.Windows.Forms.Button]::new()
    $cancelButton.Text = '取消'
    $cancelButton.SetBounds(310, 105, 90, 32)
    $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $dialog.Controls.Add($cancelButton)
    $dialog.AcceptButton = $trayButton
    $dialog.CancelButton = $cancelButton
    try { return $dialog.ShowDialog($Owner) }
    finally { $dialog.Dispose() }
}

function Start-MainTrayUi {
    param(
        [Parameter(Mandatory)][System.Windows.Forms.Form]$Form,
        [Parameter(Mandatory)][string]$Directory,
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][System.Drawing.Icon]$AppIcon,
        [scriptblock]$RefreshCards,
        [System.Windows.Forms.Button]$SyncButton,
        [System.Windows.Forms.Label]$SyncStatusLabel
    )

    $Form.Tag = [pscustomobject]@{
        TrayReady = $false
        TrayHintShown = $false
        AllowClose = $false
        SyncWatching = $false
        SyncStartedUtc = [DateTime]::MinValue
        SyncBaselineRunUtc = [DateTime]::MinValue
    }
    $trayMenu = [System.Windows.Forms.ContextMenuStrip]::new()
    $countItem = $trayMenu.Items.Add('本地可用：读取中')
    $countItem.Enabled = $false
    $expiryItem = $trayMenu.Items.Add('最近到期：读取中')
    $expiryItem.Enabled = $false
    $syncTimeItem = $trayMenu.Items.Add('Codex 核对：读取中')
    $syncTimeItem.Enabled = $false
    [void]$trayMenu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
    $openItem = $trayMenu.Items.Add('打开卡片管理')
    $settingsItem = $trayMenu.Items.Add('提醒设置')
    $syncItem = $trayMenu.Items.Add('立即同步 Codex')
    [void]$trayMenu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
    $exitItem = $trayMenu.Items.Add('退出管理窗口')
    $exitItem.ToolTipText = '到期提醒计划任务仍会运行'

    $tray = [System.Windows.Forms.NotifyIcon]::new()
    $tray.Icon = $AppIcon
    $tray.Text = 'Codex 重置卡提醒'
    $tray.ContextMenuStrip = $trayMenu
    $tray.BalloonTipTitle = 'Codex 重置卡提醒'
    $tray.BalloonTipText = '卡片管理已缩小到通知区域，单击图标可重新打开。'

    $refreshTray = {
        try {
            $status = Get-ReminderTrayStatus -Directory $Directory -NodePath $NodePath
            $countItem.Text = "本地可用：$($status.Count) 张"
            $expiryItem.Text = "最近到期：$($status.NextExpiry)"
            $syncTimeItem.Text = "Codex 核对：$($status.LastSync)"
            $tray.Text = "Codex 重置卡 · 本地可用 $($status.Count) 张"
        } catch {
            $countItem.Text = '本地卡片状态暂不可读取'
            $expiryItem.Text = '最近到期：未知'
            $syncTimeItem.Text = 'Codex 核对：未知'
            $tray.Text = 'Codex 重置卡提醒'
        }
    }
    $refreshSyncItem = {
        $syncItem.Enabled = -not $Form.Tag.SyncWatching
        $syncItem.Text = if ($Form.Tag.SyncWatching) { '正在同步 Codex…' } else { '立即同步 Codex' }
        if ($SyncButton) {
            $SyncButton.Enabled = -not $Form.Tag.SyncWatching
            $SyncButton.Text = if ($Form.Tag.SyncWatching) { '同步中…' } else { '立即同步 Codex' }
            $SyncButton.Refresh()
        }
    }
    $trayMenu.Add_Opening({ & $refreshTray; & $refreshSyncItem })

    $restore = {
        $Form.ShowInTaskbar = $true
        $Form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
        $Form.Show()
        $Form.Activate()
        $Form.BringToFront()
        $tray.Visible = $false
    }
    $openItem.Add_Click($restore)
    $settingsItem.Add_Click({
        try {
            & $restore
            if ((Show-ReminderSettings -Owner $Form -Directory $Directory -NodePath $NodePath) -eq 'OK' -and $RefreshCards) {
                & $RefreshCards
            }
        } catch {
            [System.Windows.Forms.MessageBox]::Show($Form, $_.Exception.Message, '无法打开设置') | Out-Null
        }
    })
    $syncTimer = [System.Windows.Forms.Timer]::new()
    $syncTimer.Interval = 2000
    $finishSync = {
        param([string]$Message, [bool]$Success)
        $syncTimer.Stop()
        $Form.Tag.SyncWatching = $false
        & $refreshSyncItem
        try {
            if ($RefreshCards) { & $RefreshCards }
            & $refreshTray
        } catch {
            $Message += '；刷新卡片失败：' + $_.Exception.Message
            $Success = $false
        }
        if ($SyncStatusLabel) {
            $SyncStatusLabel.ForeColor = if ($Success) {
                [System.Drawing.Color]::FromArgb(30, 130, 82)
            } else { [System.Drawing.Color]::FromArgb(185, 58, 54) }
            $SyncStatusLabel.Text = $Message
        }
        if ($tray.Visible) {
            $icon = if ($Success) { [System.Windows.Forms.ToolTipIcon]::Info } else { [System.Windows.Forms.ToolTipIcon]::Warning }
            $tray.ShowBalloonTip(5000, $(if ($Success) { 'Codex 同步完成' } else { 'Codex 同步失败' }), $Message, $icon)
        }
    }
    $syncTimer.Add_Tick({
        if (-not $Form.Tag.SyncWatching) { $syncTimer.Stop(); return }
        try {
            $task = Get-ScheduledTask -TaskName 'CodexResetCardSync' -ErrorAction Stop
            $result = Get-ScheduledTaskInfo -TaskName 'CodexResetCardSync' -ErrorAction Stop
            $runUtc = $result.LastRunTime.ToUniversalTime()
            if ($task.State -ne 'Running' -and $runUtc -gt $Form.Tag.SyncBaselineRunUtc) {
                if ($result.LastTaskResult -eq 0) {
                    & $finishSync '同步完成 · 卡片列表已刷新' $true
                } else {
                    & $finishSync '同步失败 · 已保留本地缓存，请查看 sync.log' $false
                }
            } elseif ([DateTime]::UtcNow -gt $Form.Tag.SyncStartedUtc.AddMinutes(5)) {
                & $finishSync '同步仍在进行或结果暂未返回，请稍后再查看' $false
            }
        } catch {
            & $finishSync ('无法读取同步结果：' + $_.Exception.Message) $false
        }
    })
    $startSync = {
        try {
            if ($Form.Tag.SyncWatching) { return }
            $task = Get-ScheduledTask -TaskName 'CodexResetCardSync' -ErrorAction Stop
            $result = Get-ScheduledTaskInfo -TaskName 'CodexResetCardSync' -ErrorAction Stop
            if ($task.State -eq 'Running') {
                $Form.Tag.SyncBaselineRunUtc = $result.LastRunTime.ToUniversalTime().AddTicks(-1)
            } else {
                $Form.Tag.SyncBaselineRunUtc = $result.LastRunTime.ToUniversalTime()
            }
            $Form.Tag.SyncStartedUtc = [DateTime]::UtcNow
            $Form.Tag.SyncWatching = $true
            if ($SyncStatusLabel) {
                $SyncStatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(38, 91, 177)
                $SyncStatusLabel.Text = '正在同步 Codex，请稍候…'
            }
            & $refreshSyncItem
            if ($task.State -ne 'Running') {
                Start-ScheduledTask -TaskName 'CodexResetCardSync' -ErrorAction Stop
            }
            $syncTimer.Start()
            if ($tray.Visible) {
                $tray.ShowBalloonTip(3000, 'Codex 同步中', '同步完成后会显示结果。', [System.Windows.Forms.ToolTipIcon]::Info)
            }
        } catch {
            & $finishSync ('无法启动同步：' + $_.Exception.Message) $false
        }
    }
    $syncItem.Add_Click($startSync)
    if ($SyncButton) { $SyncButton.Add_Click($startSync) }
    $tray.Add_MouseClick({
        param($sender, $eventArgs)
        if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) { & $restore }
    })
    $exitItem.Add_Click({ $Form.Tag.AllowClose = $true; $Form.Close() })
    $Form.Add_FormClosing({
        param($sender, $eventArgs)
        if ($Form.Tag.AllowClose -or $eventArgs.CloseReason -ne [System.Windows.Forms.CloseReason]::UserClosing) { return }
        $choice = Show-MainCloseChoice -Owner $Form -AppIcon $AppIcon
        if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
            $eventArgs.Cancel = $true
            $Form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
        } elseif ($choice -eq [System.Windows.Forms.DialogResult]::No) {
            $Form.Tag.AllowClose = $true
        } else {
            $eventArgs.Cancel = $true
        }
    })
    $Form.Add_Resize({
        if ($Form.Tag.TrayReady -and $Form.WindowState -eq [System.Windows.Forms.FormWindowState]::Minimized) {
            $Form.ShowInTaskbar = $false
            & $refreshTray
            $tray.Visible = $true
            if (-not $Form.Tag.TrayHintShown) {
                $tray.ShowBalloonTip(3000)
                $Form.Tag.TrayHintShown = $true
            }
        } elseif ($Form.Tag.TrayReady -and $Form.WindowState -eq [System.Windows.Forms.FormWindowState]::Normal) {
            $Form.ShowInTaskbar = $true
            $tray.Visible = $false
        }
    })
    $Form.Add_Shown({
        $Form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
        $Form.ShowInTaskbar = $true
        $Form.Tag.TrayReady = $true
        $Form.Activate()
        $Form.BringToFront()
    })
    try {
        [System.Windows.Forms.Application]::Run($Form)
    } finally {
        $syncTimer.Stop()
        $syncTimer.Dispose()
        $tray.Visible = $false
        $tray.Dispose()
        $trayMenu.Dispose()
    }
}
