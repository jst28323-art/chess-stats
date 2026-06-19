"""Health watchdog for the chess-stats backend + Cloudflare tunnel.

Runs every few minutes (via the ChessStatsWatchdog scheduled task). It is
SURGICAL and idempotent: it does nothing when healthy, and restarts ONLY the
component that is actually down, so a healthy tunnel URL is never rotated.

Checks each run:
  1. Local backend  -> GET http://127.0.0.1:8787/health
       down + port free -> relaunch backend (detached)
       down + port held -> assume transient/startup; skip (next tick handles it)
  2. Public tunnel  -> GET <tunnel.url>/health  (only after the backend is up,
     since a down backend makes the public URL 502 through a perfectly healthy
     tunnel). Retried a few times so a momentary edge/network blip does not
     trigger a needless URL rotation.
       down (after retries) -> relaunch tunnel (rotates URL + republishes
       tunnel.json so GitHub Pages re-discovers it)

Logs ONLY when it takes an action or sees an anomaly -> a quiet log means
"healthy". Confirm it is running via the task's LastRunTime.
"""
from __future__ import annotations

import socket
import subprocess
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PYTHON = REPO / "backend" / ".venv" / "Scripts" / "python.exe"
LAUNCH_BACKEND = REPO / "scripts" / "launch_backend_detached.py"
LAUNCH_TUNNEL = REPO / "scripts" / "launch_tunnel.py"
DATA = REPO / "backend" / "data"
TUNNEL_URL_FILE = DATA / "tunnel.url"
LOG = DATA / "watchdog.log"

BACKEND_HEALTH = "http://127.0.0.1:8787/health"
PORT = 8787


def log(msg: str) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    try:  # keep the log lean: trim if it grows past ~200 KB
        if LOG.exists() and LOG.stat().st_size > 200_000:
            LOG.write_text(LOG.read_text(errors="replace")[-50_000:])
    except Exception:
        pass
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")


def http_ok(url: str, timeout: float = 5.0) -> bool:
    try:
        req = urllib.request.Request(url, headers={"Cache-Control": "no-store"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.getcode() < 300
    except Exception:
        return False


def port_listening(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.0)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def run_blocking(script: Path) -> int:
    return subprocess.run(
        [str(PYTHON), str(script)], cwd=str(REPO),
        capture_output=True, text=True,
    ).returncode


def ensure_backend() -> bool:
    if http_ok(BACKEND_HEALTH, timeout=4):
        return True
    if port_listening(PORT):
        log("backend unhealthy but port 8787 held -> transient/startup, skipping this tick")
        return False
    log("backend DOWN -> relaunching")
    run_blocking(LAUNCH_BACKEND)
    for _ in range(20):
        if http_ok(BACKEND_HEALTH, timeout=3):
            log("backend recovered")
            return True
        time.sleep(1)
    log("backend FAILED to recover after relaunch")
    return False


def ensure_tunnel() -> None:
    pub = TUNNEL_URL_FILE.read_text(errors="replace").strip() if TUNNEL_URL_FILE.exists() else ""
    if not pub:
        log("no tunnel.url -> launching tunnel")
        run_blocking(LAUNCH_TUNNEL)
        return
    for _ in range(4):  # retry: don't rotate the URL over a momentary blip
        if http_ok(pub + "/health", timeout=8):
            return  # healthy -> leave the URL untouched
        time.sleep(5)
    log(f"tunnel DOWN ({pub}) -> relaunching (URL will rotate + republish)")
    run_blocking(LAUNCH_TUNNEL)
    new = TUNNEL_URL_FILE.read_text(errors="replace").strip() if TUNNEL_URL_FILE.exists() else ""
    # A fresh trycloudflare URL takes a few seconds to become publicly routable
    # ("it may take some time to be reachable"), so poll before judging.
    for _ in range(15):
        if new and new != pub and http_ok(new + "/health", timeout=8):
            log(f"tunnel recovered -> {new}")
            return
        time.sleep(2)
    log("tunnel relaunch did NOT confirm healthy")


def main() -> None:
    if ensure_backend():
        ensure_tunnel()


if __name__ == "__main__":
    main()
