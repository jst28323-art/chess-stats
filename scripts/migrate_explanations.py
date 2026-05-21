"""One-shot migration: backfill `played_reason` / `best_reason` on existing
analyses that were stored before the explanation module existed.

No engine calls -- reconstructs each ply's "position before" from the prior
ply's stored FEN (or the standard starting position for ply 1).
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

# Allow running this script as: python scripts/migrate_explanations.py
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import chess

from backend import db as backend_db, explain


def cp_loss_for_ply(prev_eval, this_eval, white_moved):
    if prev_eval is None or this_eval is None:
        return 0
    return max(0, (prev_eval - this_eval) if white_moved else (this_eval - prev_eval))


def migrate(only_missing: bool = True) -> dict:
    conn = sqlite3.connect(backend_db.db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    rows = conn.execute(
        "SELECT game_id, engine_profile, evals_json, plies_json FROM analyses"
    ).fetchall()
    updated = 0
    plies_updated = 0
    skipped = 0
    for row in rows:
        evals = json.loads(row["evals_json"] or "[]")
        plies = json.loads(row["plies_json"] or "[]")
        if not plies:
            skipped += 1
            continue
        # If only_missing, skip rows whose plies already have a played_reason key.
        if only_missing and any(p.get("played_reason") for p in plies):
            skipped += 1
            continue
        # Reconstruct board_before for each ply.
        any_change = False
        for i, ply in enumerate(plies):
            # board_before = chess.Board() if i == 0 else chess.Board(fen=plies[i-1]["fen"])
            try:
                board_before = chess.Board() if i == 0 else chess.Board(fen=plies[i - 1]["fen"])
            except Exception:
                continue
            played_uci = ply.get("uci")
            best_uci = ply.get("best_uci")
            is_best = bool(ply.get("is_best"))
            is_sac = bool(ply.get("is_sacrifice"))
            if not played_uci or not best_uci:
                continue
            if is_best:
                # Per contract: only non-best non-brilliant moves get explained.
                if ply.get("played_reason") or ply.get("best_reason"):
                    ply["played_reason"] = None
                    ply["best_reason"] = None
                    any_change = True
                continue
            # cp-loss
            prev_eval = evals[i] if i < len(evals) else None
            this_eval = evals[i + 1] if (i + 1) < len(evals) else None
            white_moved = ((ply.get("ply", i + 1) - 1) % 2 == 0)
            cp_loss = cp_loss_for_ply(prev_eval, this_eval, white_moved)
            try:
                ex = explain.explain_ply(
                    board_before, played_uci, best_uci,
                    played_eval_after=this_eval,
                    cp_loss=cp_loss,
                    mover_is_white=white_moved,
                )
            except Exception:
                continue
            new_played = ex.get("played_reason")
            new_best = ex.get("best_reason")
            if new_played != ply.get("played_reason") or new_best != ply.get("best_reason"):
                ply["played_reason"] = new_played
                ply["best_reason"] = new_best
                any_change = True
                plies_updated += 1
        if any_change:
            conn.execute(
                "UPDATE analyses SET plies_json = ?, completed_at = ? WHERE game_id = ? AND engine_profile = ?",
                (json.dumps(plies), time.time(), row["game_id"], row["engine_profile"]),
            )
            conn.commit()
            updated += 1
    conn.close()
    return {"rows_updated": updated, "plies_updated": plies_updated, "rows_skipped": skipped, "rows_total": len(rows)}


if __name__ == "__main__":
    only_missing = "--all" not in sys.argv
    print(f"migrating explanations (only_missing={only_missing})...")
    stats = migrate(only_missing=only_missing)
    print(stats)
