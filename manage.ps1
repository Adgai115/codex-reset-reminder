param([switch]$SmokeTest)

$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -LiteralPath (Join-Path $directory 'config.json') -Raw | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $directory 'settings-ui.ps1')
. (Join-Path $directory 'main-tray.ps1')

function Invoke-Cards([string[]]$arguments) {
    $output = & $config.nodePath (Join-Path $directory 'cards.mjs') @arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output | Out-String) }
    return ($output | Out-String | ConvertFrom-Json)
}

$form = [System.Windows.Forms.Form]::new()
$form.Text = 'Codex 重置卡管理'
$appIcon = [System.Drawing.Icon]::new((Join-Path $directory 'assets\app-icon.ico'))
$form.Icon = $appIcon
$form.Size = [System.Drawing.Size]::new(850, 500)
$form.MinimumSize = [System.Drawing.Size]::new(700, 400)
$form.StartPosition = 'CenterScreen'
$form.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 9)
$form.BackColor = [System.Drawing.Color]::FromArgb(248, 249, 252)

$heading = [System.Windows.Forms.Label]::new()
$heading.Text = '重置卡到期提醒'
$heading.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 16, [System.Drawing.FontStyle]::Bold)
$heading.SetBounds(24, 20, 390, 36)
$form.Controls.Add($heading)
$settingsButton = [System.Windows.Forms.Button]::new()
$settingsButton.Text = '提醒设置'
$settingsButton.SetBounds(698, 23, 110, 32)
$settingsButton.Anchor = 'Top,Right'
$form.Controls.Add($settingsButton)
$settingsButton.Add_Click({
    try {
        if ((Show-ReminderSettings -Owner $form -Directory $directory -NodePath $config.nodePath) -eq 'OK') {
            Refresh-Cards
        }
    }
    catch { [System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '无法打开设置') | Out-Null }
})
$syncLabel = [System.Windows.Forms.Label]::new()
$syncLabel.SetBounds(26, 61, 780, 22)
$syncLabel.ForeColor = [System.Drawing.Color]::FromArgb(98, 107, 124)
$form.Controls.Add($syncLabel)

$list = [System.Windows.Forms.ListView]::new()
$list.View = 'Details'
$list.FullRowSelect = $true
$list.GridLines = $false
$list.MultiSelect = $false
$list.Anchor = 'Top,Bottom,Left,Right'
$list.SetBounds(24, 100, 785, 245)
$null = $list.Columns.Add('卡片名称', 175)
$null = $list.Columns.Add('来源', 70)
$null = $list.Columns.Add('到期时间', 170)
$null = $list.Columns.Add('状态', 90)
$null = $list.Columns.Add('编号', 270)
$form.Controls.Add($list)

$reminderLabel = [System.Windows.Forms.Label]::new()
$reminderLabel.SetBounds(26, 355, 780, 24)
$reminderLabel.Anchor = 'Bottom,Left,Right'
$reminderLabel.ForeColor = [System.Drawing.Color]::FromArgb(83, 94, 111)
$form.Controls.Add($reminderLabel)

function Format-ReminderKind([string]$kind) {
    switch ($kind) {
        '7d' { '提前 7 天' }
        '3d' { '提前 3 天' }
        '1d' { '提前 1 天' }
        'snooze' { '稍后提醒' }
        'verify' { '使用反馈核验' }
        default { '提醒' }
    }
}

function Update-ReminderSelection {
    if ($list.SelectedItems.Count -eq 0) {
        $laterButton.Enabled = $false
        $reminderLabel.Text = '选择卡片可查看下次提醒，并在这里调整提醒时间。'
        return
    }
    $card = $list.SelectedItems[0].Tag
    $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    $laterButton.Enabled = $card.status -eq 'available' -and [long]$card.expiresAt -gt $now
    if ($card.status -ne 'available') {
        $reminderLabel.Text = '该卡片已不可用，不会再发送到期提醒。'
    } elseif ([long]$card.expiresAt -le $now) {
        $reminderLabel.Text = '该卡片已到期，没有后续提醒。'
    } elseif ($script:cardListChannels.Count -eq 0) {
        $reminderLabel.Text = '通知渠道已全部关闭；可在提醒设置中开启。'
    } elseif ($card.dueReminderKind) {
        $reminderLabel.Text = "待补发：$(Format-ReminderKind $card.dueReminderKind)；下次本地检查时处理。"
    } elseif ($card.nextReminderAt) {
        $at = [DateTimeOffset]::FromUnixTimeSeconds([long]$card.nextReminderAt).LocalDateTime.ToString('yyyy-MM-dd HH:mm')
        $reminderLabel.Text = "下次提醒：$at（$(Format-ReminderKind $card.nextReminderKind)）"
    } else {
        $reminderLabel.Text = '该卡片没有待发送的提醒节点。'
    }
    if ($card.snoozeTargetAt) {
        $target = [DateTimeOffset]::FromUnixTimeSeconds([long]$card.snoozeTargetAt).LocalDateTime.ToString('MM-dd HH:mm')
        $reminderLabel.Text += " · 已延期至 $target"
    }
}

function Refresh-Cards {
    $selectedId = if ($list.SelectedItems.Count -gt 0) { [string]$list.SelectedItems[0].Tag.id } else { $null }
    $response = Invoke-Cards -arguments @('list')
    $script:cardListChannels = @($response.channels)
    $list.Items.Clear()
    foreach ($card in $response.cards) {
        $expiry = [DateTimeOffset]::FromUnixTimeSeconds([long]$card.expiresAt).LocalDateTime.ToString('yyyy-MM-dd HH:mm')
        $item = [System.Windows.Forms.ListViewItem]::new([string]$card.title)
        $null = $item.SubItems.Add($(if ($card.source -eq 'codex') { 'Codex' } else { '手动' }))
        $null = $item.SubItems.Add($expiry)
        $null = $item.SubItems.Add($(if ($card.status -eq 'available' -and $card.reportedUsedAt) { '待核实' }
            else { switch ($card.status) { 'available' { '可用' } 'used' { '已使用' } default { '不可用' } } }))
        $null = $item.SubItems.Add([string]$card.id)
        $item.Tag = $card
        $null = $list.Items.Add($item)
        if ($card.id -eq $selectedId) { $item.Selected = $true }
    }
    $syncLabel.Text = if ($response.latestSync) {
        $time = [DateTimeOffset]::FromUnixTimeSeconds([long]$response.latestSync.checkedAt).LocalDateTime.ToString('yyyy-MM-dd HH:mm')
        $count = if ($response.latestCompleteSync) { "  ·  最近同步可用 $($response.latestCompleteSync.availableCount) 张" } else { '' }
        "上次 Codex 同步：$time（$($response.latestSync.outcome)）$count"
    } else { '尚未同步 Codex；可点击“立即同步 Codex”。' }
    Update-ReminderSelection
}

$list.Add_SelectedIndexChanged({ Update-ReminderSelection })

$laterButton = [System.Windows.Forms.Button]::new()
$laterButton.Text = '提醒时间'
$laterButton.SetBounds(24, 390, 110, 34)
$laterButton.Anchor = 'Bottom,Left'
$laterButton.Enabled = $false
$form.Controls.Add($laterButton)
$laterButton.Add_Click({
    if ($list.SelectedItems.Count -eq 0) { return }
    $card = $list.SelectedItems[0].Tag
    try {
        $options = Invoke-Cards -arguments @('options', [string]$card.id)
        if ($laterButton.ContextMenuStrip) { $laterButton.ContextMenuStrip.Dispose() }
        $menu = [System.Windows.Forms.ContextMenuStrip]::new()
        foreach ($option in @($options.options)) {
            $target = [DateTimeOffset]::FromUnixTimeSeconds([long]$option.targetAt).LocalDateTime.ToString('MM-dd HH:mm')
            $item = $menu.Items.Add("$($option.label) · $target")
            $item.Tag = [pscustomobject]@{ CardId = [string]$card.id; Option = [string]$option.option }
            $item.Add_Click({
                param($sender, $eventArgs)
                try {
                    $null = Invoke-Cards -arguments @('later', [string]$sender.Tag.CardId, [string]$sender.Tag.Option)
                    Refresh-Cards
                } catch { [System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '延期提醒失败') | Out-Null }
            })
        }
        if ($card.snoozeTargetAt) {
            if ($menu.Items.Count -gt 0) { [void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new()) }
            $item = $menu.Items.Add('取消当前延期')
            $item.Tag = [string]$card.id
            $item.Add_Click({
                param($sender, $eventArgs)
                try {
                    $null = Invoke-Cards -arguments @('unsnooze', [string]$sender.Tag)
                    Refresh-Cards
                } catch { [System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '取消延期失败') | Out-Null }
            })
        }
        if ($menu.Items.Count -eq 0) {
            $menu.Dispose()
            [System.Windows.Forms.MessageBox]::Show($form, '这张卡已临近到期，没有可用的稍后提醒时间。', '提醒时间') | Out-Null
            return
        }
        $laterButton.ContextMenuStrip = $menu
        $menu.Show($laterButton, [System.Drawing.Point]::new(0, $laterButton.Height))
    } catch { [System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '读取提醒选项失败') | Out-Null }
})
$syncButton = [System.Windows.Forms.Button]::new()
$syncButton.Text = '立即同步 Codex'
$syncButton.SetBounds(660, 390, 148, 34)
$syncButton.Anchor = 'Bottom,Right'
$form.Controls.Add($syncButton)
$syncStatusLabel = [System.Windows.Forms.Label]::new()
$syncStatusLabel.SetBounds(145, 396, 500, 24)
$syncStatusLabel.Anchor = 'Bottom,Left,Right'
$syncStatusLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$form.Controls.Add($syncStatusLabel)

Refresh-Cards
if ($SmokeTest) {
    $form.Opacity = 0
    $form.Add_Shown({ $form.Close() })
}
if ($SmokeTest) { [System.Windows.Forms.Application]::Run($form) }
else { Start-MainTrayUi -Form $form -Directory $directory -NodePath $config.nodePath -AppIcon $appIcon -RefreshCards { Refresh-Cards } -SyncButton $syncButton -SyncStatusLabel $syncStatusLabel }
$form.Dispose()
$appIcon.Dispose()
