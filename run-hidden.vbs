Option Explicit

If WScript.Arguments.Count <> 2 Then WScript.Quit 2

Dim shell, command
Set shell = CreateObject("WScript.Shell")
command = """" & WScript.Arguments(0) & """ -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File """ & WScript.Arguments(1) & """"
WScript.Quit shell.Run(command, 0, True)
