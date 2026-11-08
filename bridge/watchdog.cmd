@echo off
REM Watchdog tick: keep the WorkBuddy -> DSH bridge listening.
REM Runs every few minutes from the "wb-bridge-watchdog" Scheduled Task.
REM
REM Quiet on success by design: a watchdog that logs every tick is noise. Failures go to
REM reports\verdict.log via watchdog.mjs itself.
REM
REM Node resolution matches the other scripts, including the standard install locations,
REM because a Scheduled Task does not always inherit the user's PATH.
setlocal
set APPDIR=%~dp0

if defined WB_BRIDGE_NODE (
  set NODE=%WB_BRIDGE_NODE%
  goto :run
)
where node >nul 2>nul
if not errorlevel 1 (
  set NODE=node
  goto :run
)
for %%P in (
  "%ProgramFiles%\nodejs\node.exe"
  "%ProgramFiles(x86)%\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
  "%APPDIR%node\node.exe"
) do (
  if exist "%%~P" (
    set NODE=%%~P
    goto :run
  )
)
if not exist "%APPDIR%reports" mkdir "%APPDIR%reports"
echo [FAILED] Node.js not found, watchdog cannot run. Install Node 22.19+ or set WB_BRIDGE_NODE. >> "%APPDIR%reports\watchdog.log"
exit /b 1

:run
"%NODE%" "%APPDIR%watchdog.mjs" --port 8791 >> "%APPDIR%reports\watchdog.log" 2>&1
endlocal
exit /b 0
