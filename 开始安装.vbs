Option Explicit

Dim shell, folder, command
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
command = "pwsh.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File """ & folder & "\setup.ps1"""
On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then MsgBox "启动失败：请先安装 PowerShell 7。", vbExclamation, "Codex 重置卡提醒"
