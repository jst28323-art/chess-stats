"""FastAPI entrypoint for the Chess Insights+ local backend.

Endpoints:
  GET  /health
  POST /api/analyze/player/{username}
  GET  /api/jobs/{job_id}
  GET  /api/player/{username}/games
  GET  /api/game/{game_id}/analysis
  GET  /api/player/{username}/summary

Run with:
  uvicorn backend.main:app --host 0.0.0.0 --port 8787
"""
from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__, chesscom, db, stockfish_adapter, worker

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    db.init_schema()
    worker.start_worker()
    log.info("backend ready  db=%s  engine_profile=%s", db.db_path(), worker.ENGINE_PROFILE)
    try:
        yield
    finally:
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
        "server_time": time.time(),
    }


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
        "error": analysis.get("error"),
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
