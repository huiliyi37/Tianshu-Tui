@echo off
REM Windows counterpart of start-server.sh — starts the brainstorm server and
REM prints the server-started JSON. Same contract: server.cjs writes the JSON to
REM <screen_dir>\.server-info on listen and self-exits after 30 min idle.
REM
REM Usage: start-server.bat [--project-dir <path>] [--host <bind-host>]
REM                         [--url-host <display-host>] [--foreground] [--background]
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR="
set "FOREGROUND=false"
set "BIND_HOST=127.0.0.1"
set "URL_HOST="

:parse
if "%~1"=="" goto afterparse
if /i "%~1"=="--project-dir" ( set "PROJECT_DIR=%~2" & shift & shift & goto parse )
if /i "%~1"=="--host" ( set "BIND_HOST=%~2" & shift & shift & goto parse )
if /i "%~1"=="--url-host" ( set "URL_HOST=%~2" & shift & shift & goto parse )
if /i "%~1"=="--foreground" ( set "FOREGROUND=true" & shift & goto parse )
if /i "%~1"=="--no-daemon" ( set "FOREGROUND=true" & shift & goto parse )
if /i "%~1"=="--background" ( shift & goto parse )
if /i "%~1"=="--daemon" ( shift & goto parse )
echo {"error": "Unknown argument: %~1"}
exit /b 1

:afterparse
if "%URL_HOST%"=="" (
  if /i "%BIND_HOST%"=="127.0.0.1" (
    set "URL_HOST=localhost"
  ) else if /i "%BIND_HOST%"=="localhost" (
    set "URL_HOST=localhost"
  ) else (
    set "URL_HOST=%BIND_HOST%"
  )
)

REM Unique, filesystem-safe session id (no PID/date parsing headaches).
set "SESSION_ID=%RANDOM%-%RANDOM%-%RANDOM%"

if not "%PROJECT_DIR%"=="" (
  set "SCREEN_DIR=%PROJECT_DIR%\.superpowers\brainstorm\%SESSION_ID%"
) else (
  set "SCREEN_DIR=%TEMP%\brainstorm-%SESSION_ID%"
)

set "PID_FILE=%SCREEN_DIR%\.server.pid"
set "LOG_FILE=%SCREEN_DIR%\.server.log"
set "ERR_FILE=%SCREEN_DIR%\.server.err"
set "INFO_FILE=%SCREEN_DIR%\.server-info"

if not exist "%SCREEN_DIR%" mkdir "%SCREEN_DIR%"

REM Kill any leftover server from a previous run of this session dir.
if exist "%PID_FILE%" (
  set /p OLDPID=<"%PID_FILE%"
  if not "!OLDPID!"=="" taskkill /PID !OLDPID! /F >nul 2>&1
  del /f /q "%PID_FILE%" >nul 2>&1
)

cd /d "%SCRIPT_DIR%"

REM server.cjs reads these from the environment (inherited by the child).
set "BRAINSTORM_DIR=%SCREEN_DIR%"
set "BRAINSTORM_HOST=%BIND_HOST%"
set "BRAINSTORM_URL_HOST=%URL_HOST%"
REM Owner-PID monitoring is skipped on Windows (PID namespaces differ); the
REM 30-minute idle timeout prevents orphaned servers. Matches start-server.sh.
set "BRAINSTORM_OWNER_PID="

if /i "%FOREGROUND%"=="true" (
  node server.cjs
  exit /b %errorlevel%
)

REM Background launch via PowerShell so we can capture the real node PID.
REM Env vars set above are inherited by the spawned process.
set "SERVER_PID="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Start-Process -FilePath 'node' -ArgumentList 'server.cjs' -WorkingDirectory '%SCRIPT_DIR%' -WindowStyle Hidden -PassThru -RedirectStandardOutput '%LOG_FILE%' -RedirectStandardError '%ERR_FILE%').Id"`) do set "SERVER_PID=%%i"

if "%SERVER_PID%"=="" (
  echo {"error": "Failed to launch server process"}
  exit /b 1
)
echo %SERVER_PID%>"%PID_FILE%"

REM Wait for server.cjs to write .server-info (it does so on listen). Poll ~15s.
set /a tries=0
:wait
if exist "%INFO_FILE%" (
  type "%INFO_FILE%"
  exit /b 0
)
tasklist /FI "PID eq %SERVER_PID%" 2>nul | find "%SERVER_PID%" >nul
if errorlevel 1 (
  echo {"error": "Server process exited before startup. See %LOG_FILE% / %ERR_FILE%"}
  exit /b 1
)
set /a tries+=1
if %tries% GEQ 15 (
  echo {"error": "Server failed to start within timeout"}
  exit /b 1
)
REM ~1s redirect-safe sleep (timeout.exe breaks under redirected stdin).
ping -n 2 127.0.0.1 >nul
goto wait
