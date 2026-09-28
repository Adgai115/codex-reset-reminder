function Open-CodexSingletonWindow {
    param(
        [Parameter(Mandatory)][string]$MutexName,
        [Parameter(Mandatory)][string]$WindowTitle,
        [Parameter(Mandatory)][string]$ScriptPath
    )

    $mutex = [System.Threading.Mutex]::new($false, $MutexName)
    $owned = $false
    try {
        $owned = $mutex.WaitOne(0)
        if (-not $owned) {
            if (-not ('CodexReminderWindowRestore' -as [type])) {
                Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodexReminderWindowRestore {
    public delegate bool EnumProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder title, int length);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);
    public static IntPtr FindWindowByTitle(string expected) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((window, data) => {
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            if (title.ToString() == expected) {
                found = window;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
            }
            for ($attempt = 0; $attempt -lt 50; $attempt++) {
                $window = [CodexReminderWindowRestore]::FindWindowByTitle($WindowTitle)
                if ($window -ne [IntPtr]::Zero) {
                    [void][CodexReminderWindowRestore]::SendMessage($window, 0x0112, [IntPtr]::new(0xF120), [IntPtr]::Zero)
                    [void][CodexReminderWindowRestore]::ShowWindow($window, 9)
                    [void][CodexReminderWindowRestore]::SetForegroundWindow($window)
                    break
                }
                Start-Sleep -Milliseconds 100
            }
            return
        }
        & $ScriptPath
    } finally {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
