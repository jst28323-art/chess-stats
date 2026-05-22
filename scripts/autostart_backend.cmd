@echo off
REM Idempotent backend autostart used by the "ChessStatsBackend" Scheduled Task.
REM Exits 0 if port 8787 is already serving; otherwise launches the detached backend.
setlocal
cd /d "%~dp0\.."

netstat -ano | findstr /R /C:":8787 .*LISTENING" >nul
if %ERRORLEVEL% EQU 0 (
  echo [autostart_backend] port 8787 already in use, skipping launch
  exit /b 0
)

if not exist "backend\.venv\Scripts\python.exe" (
  echo [autostart_backend] venv missing -- bootstrapping via run_backend...
  call scripts\run_backend.cmd
  exit /b %ERRORLEVEL%
)

backend\.venv\Scripts\python.exe scripts\launch_backend_detached.py
exit /b %ERRORLEVEL%
