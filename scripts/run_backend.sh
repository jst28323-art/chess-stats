#!/usr/bin/env bash
# Launch the Chess Insights+ local backend on macOS/Linux.
# First run: creates a venv and installs deps. Subsequent runs reuse the venv.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x "backend/.venv/bin/python" ]; then
  echo "[run_backend] Creating venv..."
  python3 -m venv backend/.venv
  echo "[run_backend] Installing requirements..."
  backend/.venv/bin/python -m pip install --upgrade pip
  backend/.venv/bin/python -m pip install -r backend/requirements.txt
fi

echo "[run_backend] Starting uvicorn on http://localhost:8787 ..."
exec backend/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8787 --log-level info
