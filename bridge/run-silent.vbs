' run-silent.vbs - launch a console program with NO window, then wait for it and
' exit with its exit code.
'
' Why this exists: a Scheduled Task whose action is a .cmd/.bat/.exe console program
' runs it on the user's interactive desktop, so Windows pops up a console window. That
' window steals focus from whatever you are doing -- and a watchdog that fires every
' few minutes steals it every few minutes. WScript.Shell.Run's second parameter is the
' window style: 0 = hidden, so the child never draws a window at all.
'
' Usage (this is what the Scheduled Task action should be):
'   wscript.exe //nologo //B run-silent.vbs <script-to-run> [args...]
'
' The //B switch makes wscript itself silent too (it suppresses script error dialogs),
' so a broken script fails quietly instead of flashing a message box.
'
' The exit code of the child is propagated, so a task can still be marked failed by
' Task Scheduler. Paths containing spaces should be passed quoted; they are re-quoted
' here because the argument array has already been split by then.
Option Explicit

Dim fso, sh, i, target, arg, cmdline, rc

If WScript.Arguments.Count < 1 Then WScript.Quit 2

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

target = fso.GetAbsolutePathName(WScript.Arguments(0))
If Not fso.FileExists(target) Then WScript.Quit 3

cmdline = """" & target & """"
For i = 1 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If InStr(arg, " ") > 0 Then arg = """" & arg & """"
  cmdline = cmdline & " " & arg
Next

' 0 = hidden window, True = wait for it and return its exit code.
rc = sh.Run("cmd.exe /d /s /c """ & cmdline & """", 0, True)
WScript.Quit rc
