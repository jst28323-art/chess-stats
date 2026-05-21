@echo off
REM Stop the detached backend (uses pid file written by launch_backend_detached.py).
setlocal
cd /d "%~dp0\.."
if exist "backend\data\backend.pid" (
  set /p PID=<backend\data\backend.pid
  echo Stopping backend pid=%PID%
  taskkill /PID %PID% /F
  del backend\data\backend.pid
) else (
  echo No backend.pid found. Looking for uvicorn on port 8787 instead...
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr LISTENING') do taskkill /PID %%a /F
)
