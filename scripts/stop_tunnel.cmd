@echo off
REM Stop the detached cloudflared quick tunnel.
setlocal
cd /d "%~dp0\.."
if exist "backend\data\tunnel.pid" (
  set /p PID=<backend\data\tunnel.pid
  echo Stopping tunnel pid=%PID%
  taskkill /PID %PID% /F /T
  del backend\data\tunnel.pid
) else (
  echo No tunnel.pid found.
)
