@echo off
REM Idempotent tunnel autostart. Waits for backend port 8787 to be listening
REM (max ~30s), then launches the detached cloudflared tunnel which also
REM publishes the new URL to tunnel.json on origin/main.
setlocal
cd /d "%~dp0\.."

if not exist "backend\.venv\Scripts\python.exe" (
  echo [autostart_tunnel] venv missing -- run scripts\run_backend.cmd once first.
  exit /b 1
)

set /a tries=0
:waitloop
netstat -ano | findstr /R /C:":8787 .*LISTENING" >nul
if %ERRORLEVEL% EQU 0 goto ready
set /a tries+=1
if %tries% GEQ 30 (
  echo [autostart_tunnel] backend never came up on 8787, aborting
  exit /b 2
)
ping -n 2 127.0.0.1 >nul
goto waitloop

:ready
backend\.venv\Scripts\python.exe scripts\launch_tunnel.py
exit /b %ERRORLEVEL%
