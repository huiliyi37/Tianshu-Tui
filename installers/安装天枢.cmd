@echo off
rem ============================================================
rem  Tianshu One-Click Installer - double-click entry
rem  Flow: check/install WebView2 -> run Tianshu setup.exe
rem  Admin elevation (UAC) is handled inside install-tianshu.ps1
rem ============================================================
title Tianshu One-Click Installer

rem ---- run installer script (script self-elevates if needed) ----
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-tianshu.ps1"
