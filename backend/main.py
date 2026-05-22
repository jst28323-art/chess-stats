"""FastAPI entrypoint for the Chess Insights+ local backend.

Endpoints:
  GET  /health
  POST /api/analyze/player/{username}
  GET  /api/jobs/{job_id}
  GET  /api/player/{username}/games
  GET  /api/game/{game_id}/analysis
  GET  /api/player/{username}/summary
  GET  /api/player/{username}/puzzles

Run with:
  uvicorn backend.main:app --host 0.0.0.0 --port 8787
"""
from __future__ import annotations

import hashlib
import logging
import random
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import chess
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__, chesscom, db, openings, stockfish_adapter, watcher, worker

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    db.init_schema()
    # Warm the openings DB so the first analyse() in a job doesn't pay the
    # network fetch latency. Safe to fail; book detection just stays disabled.
    try:
        openings.opening_db.ensure_loaded()
    except Exception as e:  # noqa: BLE001
        log.warning("openings warmup failed: %s", e)
    worker.start_worker()
    watcher.start_watcher()
    log.info("backend ready  db=%s  engine_profile=%s  watch=%s  openings=%s",
             db.db_path(), worker.ENGINE_PROFILE, watcher.WATCH_USERS, openings.opening_db.state())
    try:
        yield
    finally:
        watcher.stop_watcher()
        worker.stop_worker()


app = FastAPI(title="Chess Insights+ Backend", version=__version__, lifespan=lifespan)

# Allow GitHub Pages frontend + local dev frontends. The backend binds to
# localhost by default so a permissive policy here is acceptable for a personal
# self-hosted service.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)


# ---------- models ----------

class AnalyzeRequest(BaseModel):
    range: str = Field("all", description="all|24h|7d|30d|90d")
    timeClass: str = Field("all", description="all|bullet|blitz|rapid|daily")
    limit: int = Field(100, ge=1, le=1000)
    forceRecompute: bool = False


class JobCreated(BaseModel):
    job_id: str


# ---------- routes ----------

@app.get("/health")
def health() -> dict[str, Any]:
    sf_ok, sf_path, sf_err = stockfish_adapter.stockfish_ok()
    counts = db.job_counts()
    return {
        "status": "ok",
        "version": __version__,
        "engine_profile": worker.ENGINE_PROFILE,
        "stockfish": {"available": sf_ok, "path": sf_path, "error": sf_err},
        "db_path": db.db_path(),
        "jobs": counts,
        "watcher": watcher.state(),
        "openings": openings.opening_db.state(),
        "server_time": time.time(),
    }


@app.get("/api/watcher/status")
def watcher_status() -> dict[str, Any]:
    return watcher.state()


@app.post("/api/analyze/player/{username}", response_model=JobCreated)
def analyze_player(username: str, body: AnalyzeRequest) -> JobCreated:
    username = username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="empty username")
    job_id = uuid.uuid4().hex
    now = time.time()
    db.insert_job({
        "id": job_id,
        "username": username,
        "time_range": body.range,
        "time_class": body.timeClass,
        "limit_n": body.limit,
        "force_recompute": 1 if body.forceRecompute else 0,
        "status": "queued",
        "progress": 0,
        "total": 0,
        "message": "queued",
        "created_at": now,
        "updated_at": now,
    })
    return JobCreated(job_id=job_id)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    job = db.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@app.get("/api/player/{username}/games")
def player_games(
    username: str,
    range: str = "all",
    timeClass: str = "all",
    limit: int = 100,
) -> dict[str, Any]:
    rows = db.get_player_games(username, range, timeClass, limit)
    analyses = db.get_analyses_for_games((r["game_id"] for r in rows), worker.ENGINE_PROFILE)
    out: list[dict[str, Any]] = []
    for row in rows:
        a = analyses.get(row["game_id"])
        persp = chesscom.perspective(row, username)
        out.append({
            "game_id": row["game_id"],
            "game_url": row["game_url"],
            "end_time": row["end_time"],
            "time_class": row["time_class"],
            "white": {"username": row["white_user"], "rating": row["white_rating"], "result": row["white_result"]},
            "black": {"username": row["black_user"], "rating": row["black_rating"], "result": row["black_result"]},
            "me_white": persp["me_white"],
            "me_user": persp["me_user"],
            "me_rating": persp["me_rating"],
            "opp_user": persp["opp_user"],
            "opp_rating": persp["opp_rating"],
            "outcome": persp["outcome"],
            "result": persp["me_result"],
            "my_engine_elo": int(a["my_engine_elo"]) if a and a.get("my_engine_elo") is not None else None,
            "opp_engine_elo": int(a["opp_engine_elo"]) if a and a.get("opp_engine_elo") is not None else None,
            "used_fallback": bool(a["used_fallback"]) if a else False,
            "null_evals": a["null_evals"] if a else 0,
            "engine_evals": a["engine_evals"] if a else 0,
            "moves_count": a["moves_count"] if a else None,
            "evals": a["evals"] if a else None,
            "has_analysis": a is not None and a.get("error") is None,
            "analysis_error": a.get("error") if a else None,
            "opening_eco": a.get("opening_eco") if a else None,
            "opening_name": a.get("opening_name") if a else None,
            "opening_ply": a.get("opening_ply") if a else None,
        })
    return {
        "username": username,
        "engine_profile": worker.ENGINE_PROFILE,
        "count": len(out),
        "games": out,
    }


@app.get("/api/game/{game_id}/analysis")
def game_analysis(game_id: str) -> dict[str, Any]:
    game = db.get_game(game_id)
    if game is None:
        raise HTTPException(status_code=404, detail="game not found")
    analysis = db.get_analysis(game_id, worker.ENGINE_PROFILE)
    if analysis is None:
        raise HTTPException(status_code=404, detail="no analysis yet")
    return {
        "game_id": game_id,
        "game_url": game["game_url"],
        "engine_profile": worker.ENGINE_PROFILE,
        "moves_count": analysis["moves_count"],
        "my_engine_elo": int(analysis["my_engine_elo"]) if analysis.get("my_engine_elo") is not None else None,
        "opp_engine_elo": int(analysis["opp_engine_elo"]) if analysis.get("opp_engine_elo") is not None else None,
        "used_fallback": bool(analysis["used_fallback"]),
        "null_evals": analysis["null_evals"],
        "engine_evals": analysis["engine_evals"],
        "evals": analysis["evals"],
        "plies": analysis["plies"],
        "opening_eco": analysis.get("opening_eco"),
        "opening_name": analysis.get("opening_name"),
        "opening_ply": analysis.get("opening_ply") or 0,
        "opening_next_uci": analysis.get("opening_next_uci"),
        "error": analysis.get("error"),
    }


_PUZZLE_CATEGORIES = {"blunder", "mistake", "inaccuracy", "missed_win"}
_STARTING_FEN = chess.STARTING_FEN


def _puzzle_category(cp_loss: int, cp_before: int, cp_after: int, mover_is_white: bool) -> str | None:
    """Bucket a non-best move into a puzzle category.

    cp_loss is from the mover's perspective. missed_win = mover had a winning
    eval (>=200cp in their favour) before the move and threw it away. Otherwise
    fall back to standard cp_loss thresholds.
    """
    pre_signed = cp_before if mover_is_white else -cp_before
    post_signed = cp_after if mover_is_white else -cp_after
    if pre_signed >= 200 and post_signed < pre_signed - 150 and post_signed < 200:
        return "missed_win"
    if cp_loss >= 200:
        return "blunder"
    if cp_loss >= 100:
        return "mistake"
    if cp_loss >= 50:
        return "inaccuracy"
    return None


def _phase_for_ply(ply: int, opening_ply: int | None) -> str:
    book_end = max(int(opening_ply or 0), 16)
    if ply <= book_end:
        return "opening"
    if ply <= 50:
        return "middlegame"
    return "endgame"


@app.get("/api/player/{username}/puzzles")
def player_puzzles(
    username: str,
    range: str = "all",
    timeClass: str = "all",
    categories: str = "blunder,mistake,missed_win",
    phase: str = "all",
    limit: int = 20,
    games_limit: int = 250,
    seed: int | None = None,
) -> dict[str, Any]:
    """Mine the user's analysed games for personalized puzzles.

    A puzzle is a position right before a non-best move the user actually
    played, where they get a chance to find the engine's best move instead.
    """
    wanted_cats = {c.strip() for c in categories.split(",") if c.strip()}
    wanted_cats &= _PUZZLE_CATEGORIES
    if not wanted_cats:
        wanted_cats = {"blunder", "mistake", "missed_win"}
    wanted_phases = {"opening", "middlegame", "endgame"} if phase == "all" else {phase}

    rows = db.get_player_games(username, range, timeClass, max(games_limit, limit * 5))
    analyses = db.get_analyses_for_games((r["game_id"] for r in rows), worker.ENGINE_PROFILE)
    rows_by_id = {r["game_id"]: r for r in rows}

    import json as _json
    candidates: list[dict[str, Any]] = []
    for gid, a in analyses.items():
        if a.get("error"):
            continue
        plies_list = _json.loads(a.get("plies_json") or "[]")
        if not plies_list:
            continue
        evals = a.get("evals") or []
        opening_ply = a.get("opening_ply") or 0
        opening_name = a.get("opening_name")
        g = rows_by_id.get(gid)
        if g is None:
            continue
        for idx, p in enumerate(plies_list):
            if not p.get("me_moved"):
                continue
            if p.get("is_best"):
                continue
            best_uci = p.get("best_uci")
            if not best_uci:
                continue
            played_ply = int(p.get("ply") or (idx + 1))
            # Position BEFORE the played move: it's plies[idx-1].fen, or the
            # starting position when this is the first move.
            if idx == 0:
                puzzle_fen = _STARTING_FEN
            else:
                prev = plies_list[idx - 1]
                puzzle_fen = prev.get("fen") or _STARTING_FEN
            # evals[0] = starting position; evals[k] = after ply k. So
            # cp_before = evals[played_ply - 1], cp_after = evals[played_ply].
            if played_ply - 1 >= len(evals) or played_ply >= len(evals):
                continue
            cp_before = int(evals[played_ply - 1]) if evals[played_ply - 1] is not None else None
            cp_after = int(evals[played_ply]) if evals[played_ply] is not None else None
            if cp_before is None or cp_after is None:
                continue
            mover_is_white = (played_ply % 2 == 1)
            cp_loss = max(0, (cp_before - cp_after) if mover_is_white else (cp_after - cp_before))
            cat = _puzzle_category(cp_loss, cp_before, cp_after, mover_is_white)
            if cat is None or cat not in wanted_cats:
                continue
            ph = _phase_for_ply(played_ply, opening_ply)
            if ph not in wanted_phases:
                continue
            puzzle_id = hashlib.sha1(f"{gid}:{played_ply}".encode()).hexdigest()[:16]
            candidates.append({
                "puzzle_id": puzzle_id,
                "game_id": gid,
                "game_url": g["game_url"],
                "end_time": g["end_time"],
                "time_class": g["time_class"],
                "opponent": g["black_user"] if (g.get("white_user", "").lower() == username.lower()) else g["white_user"],
                "ply": played_ply,
                "puzzle_fen": puzzle_fen,
                "side_to_move": "white" if mover_is_white else "black",
                "best_uci": best_uci,
                "best_san": p.get("best") or best_uci,
                "played_uci": p.get("uci"),
                "played_san": p.get("move"),
                "cp_before": cp_before,
                "cp_after_played": cp_after,
                "cp_loss": cp_loss,
                "category": cat,
                "phase": ph,
                "best_reason": p.get("best_reason"),
                "played_reason": p.get("played_reason"),
                "pv_san": p.get("pv") or "",
                "opening_name": opening_name,
            })

    rng = random.Random(seed if seed is not None else int(time.time()))
    # Prefer larger cp_loss first (more instructive), but inject randomness so
    # repeated calls don't always show the same top items.
    candidates.sort(key=lambda c: (-c["cp_loss"], rng.random()))
    chosen = candidates[: max(1, min(limit, 100))]

    counts: dict[str, int] = {}
    for c in candidates:
        counts[c["category"]] = counts.get(c["category"], 0) + 1
    return {
        "username": username,
        "engine_profile": worker.ENGINE_PROFILE,
        "total_candidates": len(candidates),
        "counts_by_category": counts,
        "puzzles": chosen,
    }


@app.get("/api/player/{username}/summary")
def player_summary(
    username: str,
    range: str = "all",
    timeClass: str = "all",
    limit: int = 100,
) -> dict[str, Any]:
    rows = db.get_player_games(username, range, timeClass, limit)
    analyses = db.get_analyses_for_games((r["game_id"] for r in rows), worker.ENGINE_PROFILE)
    wins = draws = losses = 0
    my_elo_sum = opp_elo_sum = 0
    my_eng_sum = opp_eng_sum = 0
    eng_n = 0
    analyzed = 0
    fallback_n = 0
    for r in rows:
        persp = chesscom.perspective(r, username)
        outcome = persp["outcome"]
        if outcome == "Win":
            wins += 1
        elif outcome == "Draw":
            draws += 1
        else:
            losses += 1
        if persp["me_rating"]:
            my_elo_sum += persp["me_rating"]
        if persp["opp_rating"]:
            opp_elo_sum += persp["opp_rating"]
        a = analyses.get(r["game_id"])
        if a and a.get("error") is None:
            analyzed += 1
            if a.get("used_fallback"):
                fallback_n += 1
            if a.get("my_engine_elo") is not None and a.get("opp_engine_elo") is not None:
                my_eng_sum += a["my_engine_elo"]
                opp_eng_sum += a["opp_engine_elo"]
                eng_n += 1
    n = len(rows)
    return {
        "username": username,
        "engine_profile": worker.ENGINE_PROFILE,
        "count": n,
        "wins": wins, "draws": draws, "losses": losses,
        "win_rate": (wins / n) if n else None,
        "avg_my_chess_elo": (my_elo_sum / n) if n else None,
        "avg_opp_chess_elo": (opp_elo_sum / n) if n else None,
        "analyzed": analyzed,
        "fallback_games": fallback_n,
        "avg_my_engine_elo": (my_eng_sum / eng_n) if eng_n else None,
        "avg_opp_engine_elo": (opp_eng_sum / eng_n) if eng_n else None,
    }
