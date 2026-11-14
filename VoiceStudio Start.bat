@echo off
REM ---------------------------------------------------------------------------
REM VoiceStudio server - START
REM
REM Opens the backend and the web frontend in their own windows, then waits
REM until both actually answer before saying so. Closing either window stops
REM that half; use "VoiceStudio Stop" to close both.
REM ---------------------------------------------------------------------------
setlocal
title VoiceStudio - Starting

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

echo.
echo   VoiceStudio
echo   -----------
echo   Starting the backend and the web UI...
echo.

REM This box cannot write under %APPDATA%/%TEMP% (access denied), so every
REM path the backend and the model cache use is redirected inside the repo.
REM OMNIVOICE_DATA_DIR is the one that moves the app data dir; the others keep
REM HuggingFace and uv from touching the unwritable default locations.
set "OMNIVOICE_DATA_DIR=%REPO%\.devdata"
set "OMNIVOICE_CACHE_DIR=%REPO%\.devhf"
set "HF_HOME=%REPO%\.devhf"
set "HF_HUB_CACHE=%REPO%\.devhf"
set "UV_CACHE_DIR=%REPO%\.devcache"
set "PYTHONIOENCODING=utf-8"

REM Already running? Do not start a second copy.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3900,3901 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  echo   Servers are already running. Opening the browser.
  goto :open
)

cd /d "%REPO%"

REM The two lines below must not chain `set` calls with `&&`.
REM   * `set VAR=value && next` stores "value " WITH a trailing space, because
REM     everything up to the `&&` belongs to the value. uv then refuses to
REM     start with: "Failed to initialize cache at `.devcache `", which killed
REM     the backend window silently.
REM   * so the variables are set above, on their own lines, and `cmd /k` is
REM     left with nothing but the command to run.
REM `/k` keeps the window open so its output can be read if something fails.
start "VoiceStudio Backend" cmd /k "bun run dev:api:noreload"
start "VoiceStudio Web UI" cmd /k "bun run dev:frontend"

echo   Two windows opened: "VoiceStudio Backend" and "VoiceStudio Web UI".
echo   Waiting for them to come up (the model takes 1-3 minutes to load)...
echo.

set /a TRIES=0
:wait
set /a TRIES+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3900/health' -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto :ready
if %TRIES% GEQ 180 (
  echo   The backend did not answer after 6 minutes.
  echo   Check the "VoiceStudio Backend" window for the error.
  echo.
  pause
  exit /b 1
)
<nul set /p "=."
ping -n 3 127.0.0.1 >nul 2>&1
goto :wait

:ready
echo.
echo   Ready. The web UI is at http://localhost:3901
echo.

:open
start "" "http://localhost:3901"
echo   Opening the browser...
ping -n 3 127.0.0.1 >nul 2>&1
exit /b 0
