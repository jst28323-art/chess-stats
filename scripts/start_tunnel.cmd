@echo off
REM Start a Cloudflare quick tunnel that exposes the local backend over HTTPS,
REM and publish the URL to GitHub Pages so any PC's dashboard auto-discovers it.
setlocal
cd /d "%~dp0\.."
if not exist "backend\.venv\Scripts\python.exe" (
  echo [start_tunnel] No venv yet -- run scripts\run_backend.cmd once first.
  exit /b 1
)
backend\.venv\Scripts\python.exe scripts\launch_tunnel.py
