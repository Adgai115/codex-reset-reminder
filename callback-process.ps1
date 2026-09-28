function Stop-ReminderCallbackWorker {
    param([Parameter(Mandatory)][string]$Directory)

    $workerPath = [regex]::Escape((Join-Path $Directory 'callback-worker.mjs'))
    $runnerPath = [regex]::Escape((Join-Path $Directory 'run-callback.ps1'))
    $processes = @(Get-CimInstance Win32_Process)
    $workers = @($processes | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -match $workerPath
    })
    $workerIds = @($workers | ForEach-Object ProcessId)
    $parentIds = @($workers | ForEach-Object ParentProcessId)
    $children = @($processes | Where-Object {
        $_.Name -eq 'lark-cli.exe' -and $workerIds -contains $_.ParentProcessId
    })
    $parents = @($processes | Where-Object {
        $_.Name -eq 'pwsh.exe' -and $_.CommandLine -match $runnerPath -and
        $parentIds -contains $_.ProcessId
    })
    foreach ($child in $children) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
    foreach ($worker in $workers) { Stop-Process -Id $worker.ProcessId -Force -ErrorAction SilentlyContinue }
    foreach ($parent in $parents) { Stop-Process -Id $parent.ProcessId -Force -ErrorAction SilentlyContinue }
}
