function Test-ReminderInstalled {
    param(
        [Parameter(Mandatory)][string]$Directory,
        [object[]]$Tasks
    )

    $configPath = Join-Path $Directory 'config.json'
    if (-not (Test-Path -LiteralPath $configPath)) { return $false }
    try {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if (-not $config.nodePath -or -not $config.codexScript) { return $false }
        if (-not (Test-Path -LiteralPath $config.nodePath) -or
            -not (Test-Path -LiteralPath $config.codexScript)) { return $false }
        if (-not $PSBoundParameters.ContainsKey('Tasks')) {
            $Tasks = @(Get-ScheduledTask -TaskName 'CodexResetCardSync',
                'CodexResetCardExpiryReminder' -ErrorAction SilentlyContinue)
        }
        foreach ($required in @(
            @{ Name = 'CodexResetCardSync'; Script = 'run-sync.ps1' },
            @{ Name = 'CodexResetCardExpiryReminder'; Script = 'run.ps1' }
        )) {
            $task = $Tasks | Where-Object TaskName -eq $required.Name | Select-Object -First 1
            if (-not $task) { return $false }
            $expectedPath = Join-Path $Directory $required.Script
            $actions = @($task.Actions)
            if (-not @($actions | Where-Object {
                ([string]$_.Arguments).Contains($expectedPath,
                    [System.StringComparison]::OrdinalIgnoreCase)
            }).Count) { return $false }
        }
        return $true
    } catch { return $false }
}
