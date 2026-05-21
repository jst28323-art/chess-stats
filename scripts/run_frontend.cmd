@echo off
REM Serve the static frontend on http://localhost:8000
setlocal
cd /d "%~dp0\.."
echo [run_frontend] Open http://localhost:8000 in your browser
python -m http.server 8000
