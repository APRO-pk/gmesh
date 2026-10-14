@echo off
rem ---------------------------------------------------------------------------
rem GMESH watchdog - keeps the server running.
rem
rem If the server stops for ANY reason - crash, busy port, accidental kill,
rem Windows update - it is restarted automatically. Close THIS window to stop
rem GMESH on purpose. Every start/stop is written to watchdog.log.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
title GMESH Server - watchdog

rem Point the server at this folder's own web assets and Python worker, so a
rem copied/extracted build works no matter where it lives.
set GMESH_WEB_DIR=%~dp0web
set GMESH_WORKER=%~dp0python\gmesh_worker.py

set LOG=watchdog.log
echo. >> "%LOG%"
echo [GMESH] %DATE% %TIME% watchdog started >> "%LOG%"

:loop
set GMESH_EXE=target\release\gmesh.exe
if not exist "%GMESH_EXE%" set GMESH_EXE=target\debug\gmesh.exe

if not exist "%GMESH_EXE%" goto build

:run
echo.
echo [GMESH] %DATE% %TIME%  starting %GMESH_EXE% ...
echo [GMESH] %DATE% %TIME% start %GMESH_EXE% >> "%LOG%"
"%GMESH_EXE%"
set CODE=%ERRORLEVEL%
echo.
echo [GMESH] %DATE% %TIME%  server stopped, exit code %CODE%
echo [GMESH] %DATE% %TIME% stopped, exit code %CODE% >> "%LOG%"
echo [GMESH] Restarting automatically in 3 seconds. Close this window to stop GMESH.
ping -n 4 127.0.0.1 >nul
goto loop

:build
echo.
echo [GMESH] No built server yet - building once with cargo. This can take a few minutes.
echo [GMESH] %DATE% %TIME% building >> "%LOG%"
cargo build --release
if not exist "target\release\gmesh.exe" cargo build
set GMESH_EXE=target\release\gmesh.exe
if not exist "%GMESH_EXE%" set GMESH_EXE=target\debug\gmesh.exe
if exist "%GMESH_EXE%" goto run
echo.
echo [GMESH] Still no server binary. Is Rust installed? Retrying in 10 seconds.
echo [GMESH] %DATE% %TIME% no binary available >> "%LOG%"
ping -n 11 127.0.0.1 >nul
goto loop
