@echo off
rem ---------------------------------------------------------------------------
rem GMESH launcher.
rem
rem Starts the server inside a WATCHDOG window that restarts it automatically
rem if it ever stops, then opens the app. You should never need to restart
rem anything by hand - just keep the "GMESH Server (watchdog)" window open.
rem
rem Requirements: Python 3 with the gmsh package (pip install gmsh).
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

echo [GMESH] Starting GMESH...
echo [GMESH] A watchdog window will open and keep the server alive.
echo [GMESH] Close that window to stop GMESH.

start "GMESH Server (watchdog)" cmd /k "watchdog.bat"

echo [GMESH] Waiting for the server to come up...
timeout /t 6 /nobreak >nul
start "" "http://127.0.0.1:3000"
endlocal
