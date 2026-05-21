"""SQLite schema and connection helpers for Chess Insights+ backend."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

_DB_PATH = Path(__file__).resolve().parent / "data" / "chessstats.db"
_DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# One lock guards write transactions; reads use their own short-lived connections.
_write_lock = threading.Lock()


def db_path() -> str:
    return str(_DB_PATH)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH, timeout=30.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def read_conn() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def write_conn() -> Iterator[sqlite3.Connection]:
    with _write_lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  time_range TEXT NOT NULL,
  time_class TEXT NOT NULL,
  limit_n INTEGER NOT NULL,
  force_recompute INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  message TEXT,
  error TEXT,
  created_at REAL,
  updated_at REAL,
  finished_at REAL
);
CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS games (
  game_id TEXT PRIMARY KEY,
  game_url TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  end_time INTEGER NOT NULL,
  time_class TEXT,
  rated INTEGER,
  white_user TEXT,
  white_rating INTEGER,
  white_result TEXT,
  black_user TEXT,
  black_rating INTEGER,
  black_result TEXT,
  pgn TEXT,
  fetched_at REAL
);
CREATE INDEX IF NOT EXISTS ix_games_user_end ON games(username, end_time);
CREATE INDEX IF NOT EXISTS ix_games_user_tc_end ON games(username, time_class, end_time);

CREATE TABLE IF NOT EXISTS analyses (
  game_id TEXT NOT NULL,
  engine_profile TEXT NOT NULL,
  my_engine_elo REAL,
  opp_engine_elo REAL,
  used_fallback INTEGER,
  null_evals INTEGER,
  engine_evals INTEGER,
  moves_count INTEGER,
  evals_json TEXT,
  plies_json TEXT,
  error TEXT,
  completed_at REAL,
  PRIMARY KEY (game_id, engine_profile)
);
CREATE INDEX IF NOT EXISTS ix_analyses_game ON analyses(game_id);
"""


def init_schema() -> None:
    with write_conn() as c:
        for stmt in SCHEMA.strip().split(";"):
            s = stmt.strip()
            if s:
                c.execute(s)


# ---------- Job helpers ----------

def insert_job(job: dict[str, Any]) -> None:
    with write_conn() as c:
        c.execute(
            """
            INSERT INTO jobs (id, username, time_range, time_class, limit_n, force_recompute,
                              status, progress, total, message, created_at, updated_at)
            VALUES (:id, :username, :time_range, :time_class, :limit_n, :force_recompute,
                    :status, :progress, :total, :message, :created_at, :updated_at)
            """,
            job,
        )


def update_job(job_id: str, **fields: Any) -> None:
    if not fields:
        return
    fields["updated_at"] = time.time()
    sets = ", ".join(f"{k} = :{k}" for k in fields)
    params = {**fields, "id": job_id}
    with write_conn() as c:
        c.execute(f"UPDATE jobs SET {sets} WHERE id = :id", params)


def get_job(job_id: str) -> dict[str, Any] | None:
    with read_conn() as c:
        row = c.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return dict(row) if row else None


def next_queued_job() -> dict[str, Any] | None:
    with read_conn() as c:
        row = c.execute(
            "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None


def job_counts() -> dict[str, int]:
    with read_conn() as c:
        rows = c.execute(
            "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"
        ).fetchall()
        out = {"queued": 0, "running": 0, "completed": 0, "failed": 0}
        for r in rows:
            out[r["status"]] = r["n"]
        return out


# ---------- Game helpers ----------

def upsert_game(game: dict[str, Any]) -> None:
    with write_conn() as c:
        c.execute(
            """
            INSERT INTO games (game_id, game_url, username, end_time, time_class, rated,
                               white_user, white_rating, white_result,
                               black_user, black_rating, black_result, pgn, fetched_at)
            VALUES (:game_id, :game_url, :username, :end_time, :time_class, :rated,
                    :white_user, :white_rating, :white_result,
                    :black_user, :black_rating, :black_result, :pgn, :fetched_at)
            ON CONFLICT(game_url) DO UPDATE SET
              end_time=excluded.end_time, time_class=excluded.time_class, rated=excluded.rated,
              white_user=excluded.white_user, white_rating=excluded.white_rating,
              white_result=excluded.white_result, black_user=excluded.black_user,
              black_rating=excluded.black_rating, black_result=excluded.black_result,
              pgn=excluded.pgn, fetched_at=excluded.fetched_at
            """,
            game,
        )


def get_player_games(
    username: str,
    range_key: str,
    time_class: str,
    limit_n: int,
) -> list[dict[str, Any]]:
    start_ts = _range_start_ts(range_key)
    params: list[Any] = [username.lower(), start_ts]
    sql = (
        "SELECT * FROM games WHERE LOWER(username) = ? AND end_time >= ?"
    )
    if time_class and time_class != "all":
        sql += " AND time_class = ?"
        params.append(time_class)
    sql += " ORDER BY end_time DESC LIMIT ?"
    params.append(int(limit_n))
    with read_conn() as c:
        rows = c.execute(sql, params).fetchall()
        # caller wants oldest-first to match the frontend's sort
        return [dict(r) for r in reversed(rows)]


def get_game(game_id: str) -> dict[str, Any] | None:
    with read_conn() as c:
        row = c.execute("SELECT * FROM games WHERE game_id = ?", (game_id,)).fetchone()
        return dict(row) if row else None


def _range_start_ts(range_key: str) -> int:
    now = int(time.time())
    days = {"24h": 1, "7d": 7, "30d": 30, "90d": 90}.get(range_key)
    return 0 if days is None else now - days * 86400


# ---------- Analysis helpers ----------

def get_analysis(game_id: str, engine_profile: str) -> dict[str, Any] | None:
    with read_conn() as c:
        row = c.execute(
            "SELECT * FROM analyses WHERE game_id = ? AND engine_profile = ?",
            (game_id, engine_profile),
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["evals"] = json.loads(d.pop("evals_json") or "[]")
        d["plies"] = json.loads(d.pop("plies_json") or "[]")
        return d


def get_analyses_for_games(
    game_ids: Iterable[str], engine_profile: str
) -> dict[str, dict[str, Any]]:
    ids = list(game_ids)
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    with read_conn() as c:
        rows = c.execute(
            f"SELECT * FROM analyses WHERE engine_profile = ? AND game_id IN ({placeholders})",
            [engine_profile, *ids],
        ).fetchall()
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        d = dict(r)
        d["evals"] = json.loads(d.pop("evals_json") or "[]")
        out[d["game_id"]] = d
    return out


def upsert_analysis(
    game_id: str,
    engine_profile: str,
    *,
    my_engine_elo: float | None,
    opp_engine_elo: float | None,
    used_fallback: bool,
    null_evals: int,
    engine_evals: int,
    moves_count: int,
    evals: list[int],
    plies: list[dict[str, Any]],
    error: str | None = None,
) -> None:
    with write_conn() as c:
        c.execute(
            """
            INSERT INTO analyses (game_id, engine_profile, my_engine_elo, opp_engine_elo,
                                  used_fallback, null_evals, engine_evals, moves_count,
                                  evals_json, plies_json, error, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(game_id, engine_profile) DO UPDATE SET
              my_engine_elo=excluded.my_engine_elo,
              opp_engine_elo=excluded.opp_engine_elo,
              used_fallback=excluded.used_fallback,
              null_evals=excluded.null_evals,
              engine_evals=excluded.engine_evals,
              moves_count=excluded.moves_count,
              evals_json=excluded.evals_json,
              plies_json=excluded.plies_json,
              error=excluded.error,
              completed_at=excluded.completed_at
            """,
            (
                game_id,
                engine_profile,
                my_engine_elo,
                opp_engine_elo,
                1 if used_fallback else 0,
                null_evals,
                engine_evals,
                moves_count,
                json.dumps(evals),
                json.dumps(plies),
                error,
                time.time(),
            ),
        )
