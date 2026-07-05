@echo off
REM Windows counterpart of stop-server.sh — stops the brainstorm server and
REM cleans up. Only ephemeral %TEMP%\brainstorm-* dirs are deleted; persistent
REM project dirs (.superpowers\) are kept so mockups can be reviewed later.
REM
REM Usage: stop-server.bat <screen_dir>
setlocal

set "SCREEN_DIR=%~1"
if "%SCREEN_DIR%"=="" (
  echo {"error": "Usage: stop-server.bat <screen_dir>"}
  exit /b 1
)

set "PID_FILE=%SCREEN_DIR%\.server.pid"
if not exist "%PID_FILE%" (
  echo {"status": "not_running"}
  exit /b 0
)

set /p PID=<"%PID_FILE%"
if not "%PID%"=="" taskkill /PID %PID% /T /F >nul 2>&1

del /f /q "%PID_FILE%" "%SCREEN_DIR%\.server.log" "%SCREEN_DIR%\.server.err" >nul 2>&1

REM Only remove ephemeral temp session dirs (mirrors the /tmp/* guard in the .sh).
echo "%SCREEN_DIR%" | findstr /i /c:"%TEMP%\brainstorm-" >nul
if not errorlevel 1 rmdir /s /q "%SCREEN_DIR%" >nul 2>&1

echo {"status": "stopped"}
exit /b 0
