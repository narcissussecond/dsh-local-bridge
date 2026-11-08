@echo off
REM Keep the WorkBuddy -> DSH bridge running at logon, with no console window.
REM Registered as a Scheduled Task named "wb-bridge"; this file is what it runs.
REM Node resolution matches start-wb-bridge.cmd - including the standard install
REM locations, because a Scheduled Task does not always inherit the user's PATH.
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
echo [FAILED] Node.js not found. Install Node 22.19+ or set WB_BRIDGE_NODE to node.exe>> "%APPDIR%bridge-stderr.log"
exit /b 1

:run
"%NODE%" "%APPDIR%wb-bridge.mjs" --port 8791 >> "%APPDIR%bridge-stdout.log" 2>> "%APPDIR%bridge-stderr.log"
endlocal
exit /b 0
