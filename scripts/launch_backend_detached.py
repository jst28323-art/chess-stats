"""Launch the backend in a fully detached process so it survives the current shell.

Logs are appended to backend/data/backend.log. Use scripts\\stop_backend.cmd (or
kill the PID printed below) to terminate.

Usage:
  python scripts\\launch_backend_detached.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PYTHON = REPO / "backend" / ".venv" / "Scripts" / "python.exe"
LOG_DIR = REPO / "backend" / "data"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG = LOG_DIR / "backend.log"
PID_FILE = LOG_DIR / "backend.pid"

if not PYTHON.exists():
    print(f"ERROR: missing venv python at {PYTHON}", file=sys.stderr)
    print("Run scripts\\run_backend.cmd once to bootstrap the venv first.", file=sys.stderr)
    sys.exit(1)

if os.name == "nt":
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
else:
    flags = 0

with open(LOG, "ab") as logf:
    logf.write(f"\n=== launch at {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n".encode())
    proc = subprocess.Popen(
        [
            str(PYTHON), "-m", "uvicorn", "backend.main:app",
            "--host", "127.0.0.1", "--port", "8787", "--log-level", "info",
        ],
        cwd=str(REPO),
        stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        creationflags=flags if os.name == "nt" else 0,
        close_fds=True,
        start_new_session=os.name != "nt",
    )

PID_FILE.write_text(str(proc.pid))
print(f"backend launched detached  pid={proc.pid}  log={LOG}")
print("verify: curl http://127.0.0.1:8787/health")
print(f"stop:   taskkill /PID {proc.pid} /F   (or scripts\\stop_backend.cmd)")
