@echo off
echo === Starting Tauri signed build ===
cd /d D:\Tianshu-Tui\desktop

:: Read private key
set /p PRIV_KEY=<%USERPROFILE%\.tauri\tianshu.key
set TAURI_SIGNING_PRIVATE_KEY=%PRIV_KEY%
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=

echo Key loaded. Starting tauri build...
call npx tauri build 2>&1
echo === Build finished with exit code: %ERRORLEVEL% ===
