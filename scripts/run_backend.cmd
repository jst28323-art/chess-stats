@echo off
REM Launch the Chess Insights+ local backend on Windows.
REM First run: creates a venv and installs deps. Subsequent runs reuse the venv.

setlocal
cd /d "%~dp0\.."

if not exist "backend\.venv\Scripts\python.exe" (
  echo [run_backend] Creating venv...
  python -m venv backend\.venv || goto :err
  echo [run_backend] Installing requirements...
  backend\.venv\Scripts\python.exe -m pip install --upgrade pip || goto :err
  backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt || goto :err
)

echo [run_backend] Starting uvicorn on http://localhost:8787 ...
backend\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8787 --log-level info
goto :eof

:err
echo [run_backend] FAILED. See messages above.
exit /b 1
