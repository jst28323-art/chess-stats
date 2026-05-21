@echo off
REM Start the backend detached so it survives the current shell / session.
REM First-time bootstrap (venv + deps) still goes through run_backend.cmd.
setlocal
cd /d "%~dp0\.."
if not exist "backend\.venv\Scripts\python.exe" (
  echo [start_backend_persistent] No venv yet -- bootstrapping via run_backend...
  call scripts\run_backend.cmd
  goto :eof
)
backend\.venv\Scripts\python.exe scripts\launch_backend_detached.py
