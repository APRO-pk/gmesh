@echo off
rem ---------------------------------------------------------------------------
rem GMESH watchdog - keeps the server running.
rem
rem If the server stops for ANY reason (crash, busy port, accidental kill,
rem Windows update, etc.) it is restarted automatically a few seconds later.
rem Close THIS window to stop GMESH on purpose.
rem
rem Prefers the optimised release build (starts in well under a second); falls
rem back to the debug build if the release one has not been built.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
title GMESH Server (watchdog)

set GMESH_EXE=target\release\gmesh.exe
if not exist "%GMESH_EXE%" set GMESH_EXE=target\debug\gmesh.exe

if not exist "%GMESH_EXE%" (
  echo [GMESH] No built server found - building once with cargo...
  cargo build
  if errorlevel 1 (
    echo [GMESH] Build failed. Fix the build error, then run start-gmesh.bat again.
    pause
    exit /b 1
  )
  set GMESH_EXE=target\debug\gmesh.exe
)

echo [GMESH] Using %GMESH_EXE%

:loop
echo.
echo [GMESH] %DATE% %TIME%  starting server...
"%GMESH_EXE%"
set CODE=%ERRORLEVEL%
echo.
echo [GMESH] %DATE% %TIME%  server stopped (exit code %CODE%).
echo [GMESH] Restarting automatically in 3 seconds. Close this window to stop GMESH.
timeout /t 3 /nobreak >nul
goto loop
