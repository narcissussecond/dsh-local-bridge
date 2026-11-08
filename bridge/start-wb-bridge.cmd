@echo off
REM Start the WorkBuddy -> OpenAI-compatible bridge for DSH.
REM Safe to double-click twice: a second copy detects the running one and exits quietly.
REM
REM Node resolution order (first hit wins):
REM   1. WB_BRIDGE_NODE environment variable
REM   2. "node" on PATH
REM   3. the standard install locations listed below
REM   4. a Node bundled next to this file in .\node\node.exe
REM Step 3 matters: a Scheduled Task does not always inherit the user's PATH, so relying
REM on PATH alone makes the bridge refuse to start after a reboot.
REM Nothing here assumes a particular user name.
setlocal
set APPDIR=%~dp0
set PORT=8791

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
echo [FAILED] Node.js not found. Install Node 22.19+ or set WB_BRIDGE_NODE to node.exe
pause
exit /b 1

:run
echo ============================================================
echo   WorkBuddy  -^>  DSH  bridge
echo   URL : http://127.0.0.1:%PORT%/v1
echo   Node: %NODE%
echo   Log : %APPDIR%bridge-stdout.log
echo ============================================================
echo.

"%NODE%" "%APPDIR%wb-bridge.mjs" --port %PORT%
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo [OK] The bridge is not holding this window. Either it is already running
  echo      somewhere else ^(that is fine - nothing else to do^), or it stopped cleanly.
) else (
  echo [FAILED] exit code %RC%. See the messages above and bridge-stdout.log
)
echo.
echo Press any key to close this window. (The bridge, if it was already running, keeps running.)
pause >nul
