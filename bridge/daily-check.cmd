@echo off
REM Daily self-check for the WorkBuddy -> DSH bridge.
REM Registered as Scheduled Task "wb-bridge-daily". Safe to run by hand at any time.
REM
REM Exit codes from daily-check.mjs: 0 healthy, 1 warning, 2 broken.
REM This wrapper never fails the task on those codes (the task result would look like a
REM task error); the verdict lives in the report and in the log lines appended below.
REM
REM Note: %DATE% renders in the console's OEM code page, which becomes mojibake when the
REM task runs without a console. Use PowerShell's culture-invariant ISO time instead.
REM
REM Node resolution matches start-wb-bridge.cmd: WB_BRIDGE_NODE, then PATH, then .\node\.
setlocal
set APPDIR=%~dp0
set OUT=%APPDIR%reports\task-run.log

if defined WB_BRIDGE_NODE (
  set NODE=%WB_BRIDGE_NODE%
) else (
  where node >nul 2>nul
  if not errorlevel 1 (
    set NODE=node
  ) else if exist "%APPDIR%node\node.exe" (
    set NODE=%APPDIR%node\node.exe
  ) else (
    echo [FAILED] Node.js not found. Install Node 22.19+ or set WB_BRIDGE_NODE to node.exe
    exit /b 0
  )
)

if not exist "%APPDIR%reports" mkdir "%APPDIR%reports"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-ddTHH:mm:ss"') do set STAMP=%%i

echo. >> "%OUT%"
echo ===== %STAMP% ===== >> "%OUT%"

"%NODE%" "%APPDIR%daily-check.mjs" --port 8791 >> "%OUT%" 2>&1
set RC=%ERRORLEVEL%

echo [wrapper] daily-check exit code %RC% >> "%OUT%"

REM Mirror a one-line verdict where a human will actually look.
if "%RC%"=="0" (
  echo %STAMP% OK        ^(exit 0^) >> "%APPDIR%reports\verdict.log"
) else if "%RC%"=="1" (
  echo %STAMP% WARNING   ^(exit 1^) -- see reports\wb-daily-*.md >> "%APPDIR%reports\verdict.log"
) else (
  echo %STAMP% BROKEN    ^(exit %RC%^) -- see reports\wb-daily-*.md >> "%APPDIR%reports\verdict.log"
)

endlocal
exit /b 0
