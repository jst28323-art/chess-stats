"""Background worker that picks up queued jobs and analyses them with Stockfish."""
from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from typing import Any

import chess
import chess.pgn

from . import chesscom, db, stockfish_adapter

log = logging.getLogger(__name__)

DEFAULT_DEPTH = 14
DEFAULT_MOVETIME_MS = 250
MAX_PLIES_PER_GAME = 300
ENGINE_PROFILE = f"sf_d{DEFAULT_DEPTH}_mt{DEFAULT_MOVETIME_MS}_v1"

_thread: threading.Thread | None = None
_stop = threading.Event()


def start_worker() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_run_loop, name="chess-worker", daemon=True)
    _thread.start()
    log.info("worker thread started")


def stop_worker(timeout: float = 5.0) -> None:
    _stop.set()
    t = _thread
    if t and t.is_alive():
        t.join(timeout=timeout)


def _run_loop() -> None:
    while not _stop.is_set():
        try:
            job = db.next_queued_job()
            if job is None:
                time.sleep(0.5)
                continue
            _process_job(job)
        except Exception as e:  # noqa: BLE001
            log.exception("worker loop error: %s", e)
            time.sleep(1.0)


def _process_job(job: dict[str, Any]) -> None:
    job_id = job["id"]
    username = job["username"]
    log.info("[job %s] start username=%s range=%s tc=%s limit=%s",
             job_id, username, job["time_range"], job["time_class"], job["limit_n"])
    db.update_job(job_id, status="running", message="fetching archives")

    try:
        raw = asyncio.run(chesscom.fetch_all_games(username))
    except Exception as e:  # noqa: BLE001
        log.exception("[job %s] archive fetch failed", job_id)
        db.update_job(job_id, status="failed", error=f"archive fetch: {e}", finished_at=time.time())
        return

    filtered = chesscom.filter_games(
        raw,
        username,
        job["time_range"],
        job["time_class"],
        int(job["limit_n"]),
    )
    if not filtered:
        db.update_job(job_id, status="completed", total=0, progress=0,
                      message="no games matched filter", finished_at=time.time())
        return

    # Persist game rows first so the frontend can render the feed immediately
    # while analyses are still in flight.
    rows = []
    for g in filtered:
        row = chesscom.to_row(g, username)
        db.upsert_game(row)
        rows.append(row)

    db.update_job(job_id, total=len(rows), progress=0, message="analysing")

    sf_path = stockfish_adapter.find_stockfish()
    if not sf_path:
        msg = "stockfish binary not found — see README for install"
        log.warning("[job %s] %s", job_id, msg)
        db.update_job(job_id, status="failed", error=msg, finished_at=time.time())
        return

    session: stockfish_adapter.StockfishSession | None = None
    try:
        session = stockfish_adapter.StockfishSession(sf_path)
        analysed = 0
        force = bool(job.get("force_recompute"))
        for row in rows:
            if _stop.is_set():
                break
            if not force:
                existing = db.get_analysis(row["game_id"], ENGINE_PROFILE)
                if existing is not None and existing.get("error") is None:
                    analysed += 1
                    db.update_job(job_id, progress=analysed,
                                  message=f"cached {analysed}/{len(rows)}")
                    continue
            try:
                result = _analyse_one_game(session, row, username)
                db.upsert_analysis(
                    row["game_id"],
                    ENGINE_PROFILE,
                    my_engine_elo=result["my_engine_elo"],
                    opp_engine_elo=result["opp_engine_elo"],
                    used_fallback=result["used_fallback"],
                    null_evals=result["null_evals"],
                    engine_evals=result["engine_evals"],
                    moves_count=result["moves_count"],
                    evals=result["evals"],
                    plies=result["plies"],
                )
            except Exception as e:  # noqa: BLE001
                log.exception("[job %s] game %s analysis error", job_id, row["game_id"])
                db.upsert_analysis(
                    row["game_id"], ENGINE_PROFILE,
                    my_engine_elo=None, opp_engine_elo=None, used_fallback=True,
                    null_evals=0, engine_evals=0, moves_count=0,
                    evals=[], plies=[], error=str(e),
                )
            analysed += 1
            db.update_job(job_id, progress=analysed,
                          message=f"analysed {analysed}/{len(rows)}")
        db.update_job(job_id, status="completed", finished_at=time.time(),
                      message=f"done {analysed}/{len(rows)}")
        log.info("[job %s] completed %d/%d", job_id, analysed, len(rows))
    finally:
        if session is not None:
            session.close()


# ---------- per-game analysis ----------

_PGN_STRIP = re.compile(r"\{[^}]*\}|\([^)]*\)|\[[^\]]*\]|\d+\.(\.\.)?|\$\d+|1-0|0-1|1/2-1/2|\*")


def _parse_pgn_to_board_moves(pgn_text: str) -> tuple[list[chess.Move], list[str]]:
    """Parse PGN and return (moves, san_list).

    Uses chess.pgn for robustness; falls back to a simple regex strip if needed.
    """
    if not pgn_text:
        return [], []
    try:
        import io
        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if game is not None:
            moves: list[chess.Move] = []
            sans: list[str] = []
            board = game.board()
            for mv in game.mainline_moves():
                sans.append(board.san(mv))
                moves.append(mv)
                board.push(mv)
            return moves, sans
    except Exception as e:  # noqa: BLE001
        log.debug("pgn parse fallback: %s", e)
    # Fallback: very loose tokenizer + python-chess SAN parser
    cleaned = _PGN_STRIP.sub(" ", pgn_text).strip()
    tokens = [t for t in cleaned.split() if t]
    board = chess.Board()
    moves2: list[chess.Move] = []
    sans2: list[str] = []
    for t in tokens:
        try:
            mv = board.parse_san(t)
        except Exception:
            try:
                mv = board.parse_uci(t)
            except Exception:
                continue
        sans2.append(board.san(mv))
        moves2.append(mv)
        board.push(mv)
    return moves2, sans2


def _to_elo(err: float) -> float:
    return max(500.0, min(2900.0, 2550.0 - err * 3.1))


def _analyse_one_game(
    session: stockfish_adapter.StockfishSession,
    row: dict[str, Any],
    username: str,
) -> dict[str, Any]:
    moves, sans = _parse_pgn_to_board_moves(row.get("pgn") or "")
    if not moves:
        return {
            "my_engine_elo": None, "opp_engine_elo": None,
            "used_fallback": True, "null_evals": 0, "engine_evals": 0,
            "moves_count": 0, "evals": [], "plies": [],
        }
    persp = chesscom.perspective(row, username)
    me_white = persp["me_white"]

    board = chess.Board()
    evals: list[int] = []
    plies: list[dict[str, Any]] = []
    null_evals = 0
    engine_evals = 0

    # Position 0 (before first move)
    info0 = session.analyse(board)
    prev = info0["eval_cp"] if info0["eval_cp"] is not None else 0
    evals.append(prev)
    engine_evals += 1

    my_err = 0.0
    opp_err = 0.0
    my_n = 0
    opp_n = 0

    n_moves = min(len(moves), MAX_PLIES_PER_GAME)
    for i in range(n_moves):
        mv = moves[i]
        san = sans[i] if i < len(sans) else mv.uci()
        captured_piece = None
        try:
            if board.is_capture(mv):
                cap_sq = board.ep_square if board.is_en_passant(mv) else mv.to_square
                pc = board.piece_at(cap_sq)
                if pc is not None:
                    captured_piece = pc.symbol()
        except Exception:
            captured_piece = None
        board.push(mv)
        try:
            info = session.analyse(board)
            e = info["eval_cp"]
            if e is None:
                null_evals += 1
                e = prev
            else:
                engine_evals += 1
        except Exception as ex:  # noqa: BLE001
            log.warning("position analyse failed: %s", ex)
            null_evals += 1
            e = prev
            info = {"bestmove_san": None, "bestmove_uci": None, "pv_san": "", "pv_uci": "", "mate": None}
        evals.append(e)
        delta = abs(e - prev)
        white_move = (i % 2 == 0)
        me_moved = (me_white and white_move) or (not me_white and not white_move)
        if me_moved:
            my_err += delta
            my_n += 1
        else:
            opp_err += delta
            opp_n += 1
        plies.append({
            "ply": i + 1,
            "move": san,
            "uci": mv.uci(),
            "fen": board.fen(),
            "eval": e,
            "mate": info.get("mate"),
            "best": info.get("bestmove_san") or info.get("bestmove_uci") or "-",
            "pv": info.get("pv_san") or info.get("pv_uci") or "",
            "capture": captured_piece,
            "me_moved": bool(me_moved),
        })
        prev = e

    used_fallback = False
    if my_n == 0 or opp_n == 0:
        used_fallback = True
        base = max(30.0, 140.0 - len(moves) / 2.0)
        my_err = base
        opp_err = base
        my_n = opp_n = 1

    my_engine_elo = _to_elo(my_err / my_n)
    opp_engine_elo = _to_elo(opp_err / opp_n)

    return {
        "my_engine_elo": my_engine_elo,
        "opp_engine_elo": opp_engine_elo,
        "used_fallback": used_fallback,
        "null_evals": null_evals,
        "engine_evals": engine_evals,
        "moves_count": len(moves),
        "evals": evals,
        "plies": plies,
    }
