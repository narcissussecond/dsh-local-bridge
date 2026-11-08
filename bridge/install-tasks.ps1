# Registers this bridge's Scheduled Tasks.
#
#   .\install-tasks.ps1                # register both (watchdog + daily check)
#   .\install-tasks.ps1 -WhatIfOnly    # show the resolved XML, register nothing
#   .\install-tasks.ps1 -Unregister    # remove both
#   .\install-tasks.ps1 -At 09:30      # daily check time (default 08:00)
#
# Three tasks, three jobs:
#   wb-bridge           at logon          start the bridge
#   wb-bridge-watchdog  every 5 minutes   revive it if it stops listening
#   wb-bridge-daily     daily 08:00       run stats, upstream drift, end-to-end probe
#
# All three launch through run-silent.vbs (wscript.exe, window style 0). A task with an
# InteractiveToken principal runs on the user's desktop, so a bare .cmd/.bat action shows
# a real console window — for the watchdog, a window every 5 minutes. Never register a
# console action directly; see the comments in each .task.xml.
#
# The .task.xml files in this repository are templates: the user's SID and the bridge
# directory are placeholders, so the published repo contains neither. They are filled in
# here, on the machine that actually runs the tasks.
#
# We register with `schtasks /create /xml` rather than the ScheduledTasks cmdlets: on this
# class of machine Register-ScheduledTask fails with an opaque "unspecified error"
# (0x80004005) once a Principal is involved.
[CmdletBinding()]
param(
  [string]$At = '08:00',
  [switch]$Unregister,
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$tasks = @(
  @{ Name = 'wb-bridge';          Template = 'wb-bridge.task.xml';          Start = $null },
  @{ Name = 'wb-bridge-watchdog'; Template = 'wb-bridge-watchdog.task.xml'; Start = (Get-Date).Date.AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss') },
  @{ Name = 'wb-bridge-daily';    Template = 'wb-bridge-daily.task.xml';    Start = (Get-Date).Date.Add([TimeSpan]::Parse($At)).ToString('yyyy-MM-ddTHH:mm:ss') }
)

if ($Unregister) {
  # removes all three tasks
  foreach ($t in $tasks) {
    schtasks /query /tn $t.Name *> $null
    if ($LASTEXITCODE -ne 0) { Write-Host "  '$($t.Name)' not registered."; continue }
    schtasks /delete /tn $t.Name /f | Out-Null
    Write-Host "  removed '$($t.Name)'"
  }
  return
}

# The SID of the user who will run the tasks. Resolved here, never stored in the repo.
$sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
# The same account as a name, needed by the logon trigger (see wb-bridge.task.xml).
$userName = [Security.Principal.WindowsIdentity]::GetCurrent().Name

foreach ($t in $tasks) {
  $path = Join-Path $bridgeDir $t.Template
  if (-not (Test-Path -LiteralPath $path)) { throw "template not found: $path" }

  $xml = (Get-Content -LiteralPath $path -Raw).
    Replace('{{USER_SID}}', $sid).
    Replace('{{USER_NAME}}', $userName).
    Replace('{{BRIDGE_DIR}}', $bridgeDir).
    Replace('{{START_BOUNDARY}}', $t.Start)

  if ($WhatIfOnly) {
    Write-Host "--- $($t.Name) ---"
    Write-Host $xml
    continue
  }

  # schtasks reads the file as UTF-16 when the declaration says so; write it back the same way.
  $temp = Join-Path ([IO.Path]::GetTempPath()) "$($t.Name).xml"
  [IO.File]::WriteAllText($temp, $xml, [Text.Encoding]::Unicode)
  try {
    $out = schtasks /create /tn $t.Name /xml $temp /f 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
    Write-Host "  registered '$($t.Name)'"
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ''
foreach ($t in $tasks) {
  $info = schtasks /query /tn $t.Name /fo LIST /v 2>&1
  ($info -split "`r?`n" | Where-Object { $_ -match 'TaskName|Next Run|Status' }) | ForEach-Object { Write-Host ('  ' + $_.Trim()) }
}
