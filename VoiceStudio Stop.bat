@echo off
REM ---------------------------------------------------------------------------
REM VoiceStudio server - STOP
REM
REM Closes the backend and the web UI. The actual work lives in
REM scripts\stop-servers.ps1: a server is a deep process tree
REM (cmd -> bun -> bun -> uv -> uvicorn -> python) and it has to be killed from
REM the top, which is not expressible in batch without unparseable quoting.
REM ---------------------------------------------------------------------------
setlocal
title VoiceStudio - Stopping

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

echo.
echo   VoiceStudio
echo   -----------
echo   Stopping the backend and the web UI...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\stop-servers.ps1"
if errorlevel 1 (
  echo.
  echo   Some servers may still be running.
  echo.
)

echo.
echo   VoiceStudio is stopped.
echo.

ping -n 3 127.0.0.1 >nul 2>&1
exit /b 0
