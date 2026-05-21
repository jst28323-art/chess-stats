"""Polling watcher that auto-enqueues analysis jobs for watched usernames.

Every WATCH_INTERVAL_SECS, for each user in WATCH_USERS, enqueues a normal
analyze_player job (range/limit configurable). The job system de-duplicates
work via the (game_id, engine_profile) cache, so polls touch zero engine work
when there are no new games.

On startup, also enqueues a one-shot initial backfill (range=all by default)
so we have a meaningful corpus immediately.

Env vars (all optional):
  WATCH_USERS              comma-separated list (default: jst28323)
  WATCH_INTERVAL_SECS      default 300
  WATCH_RANGE              default 7d
  WATCH_LIMIT              default 100
  WATCH_INITIAL_RANGE      default all
  WATCH_INITIAL_LIMIT      default 200
  WATCH_INITIAL_ENABLED    default 1
"""
from __future__ import annotations

import logging
import os
import threading
import time
import uuid

from . import db

log = logging.getLogger(__name__)

WATCH_USERS = [u.strip() for u in (os.environ.get("WATCH_USERS") or "jst28323").split(",") if u.strip()]
POLL_INTERVAL = int(os.environ.get("WATCH_INTERVAL_SECS") or 300)
WATCH_RANGE = os.environ.get("WATCH_RANGE") or "7d"
WATCH_LIMIT = int(os.environ.get("WATCH_LIMIT") or 100)
INITIAL_BACKFILL_RANGE = os.environ.get("WATCH_INITIAL_RANGE") or "all"
INITIAL_BACKFILL_LIMIT = int(os.environ.get("WATCH_INITIAL_LIMIT") or 200)
INITIAL_BACKFILL_ENABLED = (os.environ.get("WATCH_INITIAL_ENABLED") or "1") != "0"

_thread: threading.Thread | None = None
_stop = threading.Event()
_last_poll_at: float | None = None
_last_enqueued_at: dict[str, float] = {}


def state() -> dict:
    return {
        "running": bool(_thread and _thread.is_alive()),
        "users": WATCH_USERS,
        "interval_secs": POLL_INTERVAL,
        "range": WATCH_RANGE,
        "limit": WATCH_LIMIT,
        "initial": {
            "enabled": INITIAL_BACKFILL_ENABLED,
            "range": INITIAL_BACKFILL_RANGE,
            "limit": INITIAL_BACKFILL_LIMIT,
        },
        "last_poll_at": _last_poll_at,
        "last_enqueued_at": dict(_last_enqueued_at),
    }


def start_watcher() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    if INITIAL_BACKFILL_ENABLED:
        for u in WATCH_USERS:
            try:
                _maybe_enqueue(u, INITIAL_BACKFILL_RANGE, INITIAL_BACKFILL_LIMIT, label="initial-backfill")
            except Exception as e:  # noqa: BLE001
                log.exception("watcher initial-backfill failed for %s: %s", u, e)
    _thread = threading.Thread(target=_loop, name="chess-watcher", daemon=True)
    _thread.start()
    log.info("watcher thread started users=%s interval=%ds", WATCH_USERS, POLL_INTERVAL)


def stop_watcher(timeout: float = 3.0) -> None:
    _stop.set()
    t = _thread
    if t and t.is_alive():
        t.join(timeout=timeout)


def _has_pending_job(username: str) -> bool:
    with db.read_conn() as c:
        row = c.execute(
            "SELECT 1 FROM jobs WHERE LOWER(username) = ? AND status IN ('queued','running') LIMIT 1",
            (username.lower(),),
        ).fetchone()
        return row is not None


def _maybe_enqueue(username: str, range_key: str, limit: int, *, label: str) -> str | None:
    if _has_pending_job(username):
        log.info("watcher: %s has pending job; skipping %s", username, label)
        return None
    now = time.time()
    job_id = uuid.uuid4().hex
    db.insert_job({
        "id": job_id,
        "username": username,
        "time_range": range_key,
        "time_class": "all",
        "limit_n": int(limit),
        "force_recompute": 0,
        "status": "queued",
        "progress": 0,
        "total": 0,
        "message": f"watcher: {label}",
        "created_at": now,
        "updated_at": now,
    })
    _last_enqueued_at[username] = now
    log.info("watcher: enqueued %s job %s for %s (range=%s, limit=%d)",
             label, job_id, username, range_key, limit)
    return job_id


def _loop() -> None:
    global _last_poll_at
    while not _stop.is_set():
        # Wait first so we don't immediately re-poll after the startup backfill enqueue.
        if _stop.wait(POLL_INTERVAL):
            break
        _last_poll_at = time.time()
        for u in WATCH_USERS:
            try:
                _maybe_enqueue(u, WATCH_RANGE, WATCH_LIMIT, label="poll")
            except Exception as e:  # noqa: BLE001
                log.exception("watcher poll error for %s: %s", u, e)
