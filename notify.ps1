param(
    [Parameter(Mandatory)][string]$CardName,
    [Parameter(Mandatory)][string]$CreditId,
    [Parameter(Mandatory)][string]$ExpiresLocal,
    [Parameter(Mandatory)][int]$Days,
    [Parameter(Mandatory)][string]$ReadyPath,
    [int]$AutoCloseSeconds = 0,
    [int]$StackIndex = 0,
    [int]$CurrentAvailableCount = -1,
    [long]$SyncedAt = 0,
    [switch]$Simulation,
    [switch]$Manual
)

$ErrorActionPreference = 'Stop'
$script:reminderDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function New-Color([int]$red, [int]$green, [int]$blue) {
    return [System.Drawing.Color]::FromArgb($red, $green, $blue)
}

function Set-RoundedRegion([System.Windows.Forms.Control]$control, [int]$radius) {
    $diameter = $radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    try {
        $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
        $path.AddArc($control.Width - $diameter - 1, 0, $diameter, $diameter, 270, 90)
        $path.AddArc($control.Width - $diameter - 1, $control.Height - $diameter - 1, $diameter, $diameter, 0, 90)
        $path.AddArc(0, $control.Height - $diameter - 1, $diameter, $diameter, 90, 90)
        $path.CloseFigure()
        $control.Region = [System.Drawing.Region]::new($path)
    } finally {
        $path.Dispose()
    }
}

$ink = New-Color 25 38 55
$muted = New-Color 108 121 139
$accent = New-Color 255 111 0
$canvas = [System.Drawing.Color]::White
$softAccent = New-Color 255 237 224
$softPanel = New-Color 247 248 250
$line = New-Color 224 229 235

$form = [System.Windows.Forms.Form]::new()
$form.Text = 'Codex 重置卡提醒'
$appIcon = [System.Drawing.Icon]::new((Join-Path $script:reminderDirectory 'assets\app-icon.ico'))
$form.Icon = $appIcon
$form.Tag = $ReadyPath
$form.ClientSize = [System.Drawing.Size]::new(760, 500)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.TopMost = $true
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.BackColor = $canvas
$form.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10)
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$column = [Math]::Floor($StackIndex / 2)
$row = $StackIndex % 2
$left = [Math]::Max($area.Left + 8, $area.Right - $form.Width - 20 - 780 * $column)
$top = [Math]::Max($area.Top + 8, $area.Bottom - $form.Height - 20 - 520 * $row)
$form.Location = [System.Drawing.Point]::new($left, $top)

$icon = [System.Windows.Forms.Label]::new()
$icon.Text = '!'
$icon.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$icon.BackColor = $accent
$icon.ForeColor = [System.Drawing.Color]::White
$icon.Font = [System.Drawing.Font]::new('Segoe UI', 27, [System.Drawing.FontStyle]::Bold)
$icon.SetBounds(28, 24, 60, 60)
Set-RoundedRegion $icon 30
$form.Controls.Add($icon)

$heading = [System.Windows.Forms.Label]::new()
$heading.Text = 'Codex 重置卡即将到期'
$heading.ForeColor = $ink
$heading.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 21, [System.Drawing.FontStyle]::Bold)
$heading.SetBounds(106, 30, 475, 45)
$form.Controls.Add($heading)

$badge = [System.Windows.Forms.Label]::new()
$badge.Text = if ($Simulation) { '仿真测试' } elseif ($Days -eq 0) { '今天到期' } else { '即将到期' }
$badge.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$badge.BackColor = $softAccent
$badge.ForeColor = New-Color 228 91 0
$badge.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$badge.SetBounds(612, 34, 116, 34)
Set-RoundedRegion $badge 12
$form.Controls.Add($badge)

$heroNumber = [System.Windows.Forms.Label]::new()
$heroNumber.Text = if ($Days -eq 0) { '0' } else { [string]$Days }
$heroNumber.ForeColor = $accent
$heroNumber.Font = [System.Drawing.Font]::new('Segoe UI', 62, [System.Drawing.FontStyle]::Bold)
$heroNumber.SetBounds(34, 91, 118, 96)
$form.Controls.Add($heroNumber)

$heroSuffix = [System.Windows.Forms.Label]::new()
$heroSuffix.Text = if ($Days -eq 0) { '今天到期' } else { '天后到期' }
$heroSuffix.ForeColor = $ink
$heroSuffix.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 31, [System.Drawing.FontStyle]::Bold)
$heroSuffix.SetBounds(156, 119, 420, 58)
$form.Controls.Add($heroSuffix)

$name = [System.Windows.Forms.Label]::new()
$name.Text = $CardName
$name.ForeColor = $ink
$name.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 17, [System.Drawing.FontStyle]::Bold)
$name.AutoEllipsis = $true
$name.SetBounds(34, 192, 690, 38)
$form.Controls.Add($name)

$detail = [System.Windows.Forms.Panel]::new()
$detail.BackColor = $softPanel
$detail.SetBounds(28, 244, 704, 105)
Set-RoundedRegion $detail 12
$form.Controls.Add($detail)

$expiryLabel = [System.Windows.Forms.Label]::new()
$expiryLabel.Text = '到期时间'
$expiryLabel.ForeColor = $muted
$expiryLabel.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 11)
$expiryLabel.SetBounds(30, 14, 270, 25)
$detail.Controls.Add($expiryLabel)
$tooltip = [System.Windows.Forms.ToolTip]::new()
$expiryValue = [System.Windows.Forms.Label]::new()
$expiryValue.Text = $ExpiresLocal
$expiryValue.ForeColor = $ink
$expiryValue.Font = [System.Drawing.Font]::new('Segoe UI', 17)
$expiryValue.SetBounds(30, 48, 300, 35)
$detail.Controls.Add($expiryValue)

$detailDivider = [System.Windows.Forms.Panel]::new()
$detailDivider.BackColor = $line
$detailDivider.SetBounds(352, 14, 1, 76)
$detail.Controls.Add($detailDivider)

$idLabel = [System.Windows.Forms.Label]::new()
$idLabel.Text = '卡片编号'
$idLabel.ForeColor = $muted
$idLabel.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 11)
$idLabel.SetBounds(382, 14, 280, 25)
$detail.Controls.Add($idLabel)

$identifier = [System.Windows.Forms.Label]::new()
$identifier.Text = $CreditId
$identifier.ForeColor = $ink
$identifier.Font = [System.Drawing.Font]::new('Segoe UI', 15)
$identifier.AutoEllipsis = $true
$identifier.SetBounds(382, 48, 292, 35)
$detail.Controls.Add($identifier)
$tooltip.SetToolTip($identifier, $CreditId)

$hint = [System.Windows.Forms.Label]::new()
$lastCheck = if ($SyncedAt -gt 0) { [DateTimeOffset]::FromUnixTimeSeconds($SyncedAt).ToLocalTime().ToString('MM-dd HH:mm') } else { $null }
$stale = $SyncedAt -gt 0 -and ([DateTimeOffset]::Now.ToUnixTimeSeconds() - $SyncedAt) -gt 86400
$hint.Text = if ($Simulation) { '演示模式：按钮不会操作真实卡片。' } elseif ($Manual) { '手动卡片可在本地管理窗口标记已使用。' } elseif ($CurrentAvailableCount -ge 0) { "Codex 可用 $CurrentAvailableCount 张 · 核对 $lastCheck$(if ($stale) { '（数据可能已过时）' })" } else { '在 Codex 中查看卡片；使用反馈可在飞书卡片中处理。' }
$hint.ForeColor = $muted
$hint.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 9)
$hint.SetBounds(32, 375, 690, 25)
$form.Controls.Add($hint)

$laterButton = [System.Windows.Forms.Button]::new()
$laterButton.Text = '稍后提醒'
$laterButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$laterButton.FlatAppearance.BorderSize = 0
$laterButton.BackColor = [System.Drawing.Color]::White
$laterButton.FlatAppearance.BorderColor = $line
$laterButton.FlatAppearance.BorderSize = 1
$laterButton.ForeColor = $ink
$laterButton.Cursor = [System.Windows.Forms.Cursors]::Hand
$laterButton.SetBounds(228, 425, 180, 42)
Set-RoundedRegion $laterButton 10
$laterButton.Add_Click({
    try {
        if ($Simulation) {
            $choices = @(
                [pscustomobject]@{ option = '1d'; label = '1 天后' },
                [pscustomobject]@{ option = '3d'; label = '3 天后' },
                [pscustomobject]@{ option = 'tomorrow10'; label = '明天 10:00' }
            )
        } else {
            $config = Get-Content -LiteralPath (Join-Path $script:reminderDirectory 'config.json') -Raw | ConvertFrom-Json
            $output = & $config.nodePath (Join-Path $script:reminderDirectory 'cards.mjs') options $CreditId 2>&1
            if ($LASTEXITCODE -ne 0) { throw ($output | Out-String) }
            $choices = @(($output | Out-String | ConvertFrom-Json).options)
        }
        if ($choices.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show($form, '距离到期时间太近，三个固定延期选项都已不可用。', '无法延期') | Out-Null
            return
        }

        $choiceDialog = [System.Windows.Forms.Form]::new()
        $choiceDialog.Text = '选择提醒时间'
        $choiceDialog.Icon = $appIcon
        $choiceDialog.ClientSize = [System.Drawing.Size]::new(390, 180)
        $choiceDialog.FormBorderStyle = 'FixedDialog'
        $choiceDialog.StartPosition = 'CenterParent'
        $choiceDialog.MaximizeBox = $false
        $choiceDialog.MinimizeBox = $false
        $choiceDialog.Font = $form.Font
        $choiceLabel = [System.Windows.Forms.Label]::new()
        $choiceLabel.Text = '请选择下次提醒时间（官方到期时间不变）'
        $choiceLabel.SetBounds(20, 22, 350, 28)
        $choiceDialog.Controls.Add($choiceLabel)
        $choicePicker = [System.Windows.Forms.ComboBox]::new()
        $choicePicker.DropDownStyle = 'DropDownList'
        $choicePicker.SetBounds(20, 64, 350, 32)
        foreach ($choice in $choices) {
            $label = if ($null -ne $choice.targetAt) {
                $time = [DateTimeOffset]::FromUnixTimeSeconds([long]$choice.targetAt).ToLocalTime().ToString('MM-dd HH:mm')
                '{0}  ·  {1}' -f $choice.label, $time
            } else { [string]$choice.label }
            [void]$choicePicker.Items.Add($label)
        }
        $choicePicker.SelectedIndex = 0
        $choiceDialog.Controls.Add($choicePicker)
        $choiceOk = [System.Windows.Forms.Button]::new()
        $choiceOk.Text = '确定'
        $choiceOk.SetBounds(270, 120, 100, 32)
        $choiceOk.Add_Click({ $choiceDialog.DialogResult = [System.Windows.Forms.DialogResult]::OK; $choiceDialog.Close() })
        $choiceDialog.Controls.Add($choiceOk)
        $choiceDialog.AcceptButton = $choiceOk
        $decision = $choiceDialog.ShowDialog($form)
        $selectedIndex = $choicePicker.SelectedIndex
        $choiceDialog.Dispose()
        if ($decision -ne [System.Windows.Forms.DialogResult]::OK) { return }
        $selected = $choices[$selectedIndex]

        if ($Simulation) {
            $message = "仿真：选择了 $($selected.label)，未更改真实卡片。"
        } else {
            $output = & $config.nodePath (Join-Path $script:reminderDirectory 'cards.mjs') later $CreditId ([string]$selected.option) 2>&1
            if ($LASTEXITCODE -ne 0) { throw ($output | Out-String) }
            $plan = $output | Out-String | ConvertFrom-Json
            $time = [DateTimeOffset]::FromUnixTimeSeconds([long]$plan.targetAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm')
            $message = "将在 $time 再次提醒这张卡片；官方到期时间不变。"
        }
        [System.Windows.Forms.MessageBox]::Show($form, $message, '已安排稍后提醒') | Out-Null
        $form.Close()
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '稍后提醒失败') | Out-Null
    }
})
$form.Controls.Add($laterButton)
$form.AcceptButton = $laterButton

$openButton = [System.Windows.Forms.Button]::new()
$openButton.Text = if ($Simulation) { '模拟打开 Codex' } else { '打开 Codex' }
$openButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$openButton.FlatAppearance.BorderSize = 0
$openButton.BackColor = $accent
$openButton.ForeColor = [System.Drawing.Color]::White
$openButton.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
$openButton.Cursor = [System.Windows.Forms.Cursors]::Hand
$openButton.SetBounds(32, 425, 180, 42)
Set-RoundedRegion $openButton 10
$form.Controls.Add($openButton)
$openButton.Add_Click({
    if ($Simulation) {
        [System.Windows.Forms.MessageBox]::Show('仿真：没有打开 Codex，也没有更改真实卡片。', 'Codex 重置卡提醒') | Out-Null
        $form.Close()
        return
    }
    try {
        Start-Process 'codex://'
        $form.Close()
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '打开 Codex 失败') | Out-Null
    }
})
$form.Add_Shown({
    [System.IO.File]::WriteAllText([string]$form.Tag, 'ready')
    $form.Activate()
    $form.BringToFront()
})

if ($AutoCloseSeconds -gt 0) {
    $timer = [System.Windows.Forms.Timer]::new()
    $timer.Interval = $AutoCloseSeconds * 1000
    $timer.Add_Tick({ $timer.Stop(); $form.Close() })
    $timer.Start()
}

try {
    [System.Windows.Forms.Application]::Run($form)
} finally {
    if ($timer) { $timer.Dispose() }
    $form.Dispose()
    $appIcon.Dispose()
}
