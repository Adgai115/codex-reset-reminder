param([Parameter(Mandatory)][int]$TargetPid, [Parameter(Mandatory)][string]$ButtonName)
$ErrorActionPreference = 'Stop'
# 使用原生按钮消息，避免 UI Automation 在模态窗口中的同步调用阻塞。
# 只枚举隔离测试进程，不移动鼠标，也不向其他应用发送按键。
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodexDialogTest {
  private delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static bool Click(int process, string label) {
    bool clicked = false;
    EnumWindows((window, _) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner != process) return true;
      var title = new StringBuilder(256);
      GetWindowText(window, title, title.Capacity);
      if (label == "__close_manage__" && title.ToString() == "Codex 重置卡提醒") {
        clicked = PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
        return false;
      }
      EnumChildWindows(window, (control, parameter) => {
        var text = new StringBuilder(256); var type = new StringBuilder(64);
        GetWindowText(control, text, text.Capacity); GetClassName(control, type, type.Capacity);
        if (type.ToString() == "Button" && text.ToString().Replace("&", "").Trim() == label) {
          clicked = PostMessage(control, 0x00F5, IntPtr.Zero, IntPtr.Zero);
          return false;
        }
        return true;
      }, IntPtr.Zero);
      return !clicked;
    }, IntPtr.Zero);
    return clicked;
  }
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  if ([CodexDialogTest]::Click($TargetPid, $ButtonName)) {
    Write-Output "已选择：$ButtonName"
    exit 0
  }
  Start-Sleep -Milliseconds 150
} while ([DateTime]::UtcNow -lt $deadline)
throw "未找到测试进程中的按钮：$ButtonName"
