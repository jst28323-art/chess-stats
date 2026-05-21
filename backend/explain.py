"""Heuristic move-explanation module.

Produces two short captions for each ply that wasn't best/brilliant/book:
  - best_reason:   why the engine's recommendation would be better
  - played_reason: why the actual move was worse

Pure rules + python-chess introspection -- no engine calls and no LLM. The
captions are necessarily approximate; the goal is a chess.com-Insights-style
one-liner that captures the most salient motif (capture / check / fork /
hanging piece / missed material) plus a cp-delta fallback when nothing
concrete fires.
"""
from __future__ import annotations

from typing import Optional

import chess

PIECE_VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 99}
PIECE_NAMES = {chess.PAWN: "pawn", chess.KNIGHT: "knight", chess.BISHOP: "bishop", chess.ROOK: "rook", chess.QUEEN: "queen", chess.KING: "king"}


def _pv(p: Optional[chess.Piece]) -> int:
    return PIECE_VALUES.get(p.piece_type, 0) if p else 0


def _pn(p: Optional[chess.Piece]) -> str:
    return PIECE_NAMES.get(p.piece_type, "?") if p else "?"


def _sq(sq: int) -> str:
    return chess.square_name(sq)


def _hung_pieces(board: chess.Board, color: bool) -> list[tuple[int, chess.Piece]]:
    """Pieces of `color` that are attacked by a strictly-lower-value piece OR
    attacked-and-undefended on the current board.
    """
    hung: list[tuple[int, chess.Piece]] = []
    for sq in chess.SQUARES:
        p = board.piece_at(sq)
        if not p or p.color != color or p.piece_type == chess.KING:
            continue
        attackers = board.attackers(not color, sq)
        if not attackers:
            continue
        defenders = board.attackers(color, sq)
        min_att = min(_pv(board.piece_at(a)) for a in attackers)
        if not defenders or min_att < _pv(p):
            hung.append((sq, p))
    return hung


def _attacks_from(board: chess.Board, sq: int, color: bool) -> list[tuple[int, chess.Piece]]:
    """Enemy pieces attacked from `sq` (assumes a piece of `color` is on sq)."""
    out: list[tuple[int, chess.Piece]] = []
    for t in board.attacks(sq):
        tp = board.piece_at(t)
        if tp and tp.color != color:
            out.append((t, tp))
    return out


def explain_ply(
    board_before: chess.Board,
    played_uci: str,
    best_uci: Optional[str],
    *,
    played_eval_after: Optional[int],
    cp_loss: int,
    mover_is_white: bool,
) -> dict:
    """Return {best_reason, played_reason} or {None, None}."""
    out = {"best_reason": None, "played_reason": None}
    if not played_uci or not best_uci:
        return out
    try:
        played = chess.Move.from_uci(played_uci)
        best = chess.Move.from_uci(best_uci)
    except Exception:
        return out
    if played == best:
        return out

    mover = board_before.piece_at(played.from_square)
    mover_color = mover.color if mover is not None else (chess.WHITE if mover_is_white else chess.BLACK)

    # ---- Best move motifs ----
    best_reasons: list[str] = []
    best_mover_piece = board_before.piece_at(best.from_square)

    if board_before.is_capture(best):
        cap_sq = board_before.ep_square if board_before.is_en_passant(best) else best.to_square
        cap_piece = board_before.piece_at(cap_sq)
        if cap_piece is not None:
            gain = _pv(cap_piece) - _pv(best_mover_piece)
            if gain > 0:
                best_reasons.append(f"wins the {_pn(cap_piece)} on {_sq(cap_sq)}")
            else:
                best_reasons.append(f"captures the {_pn(cap_piece)} on {_sq(cap_sq)}")

    if board_before.gives_check(best):
        # Check for forced mate via short PV depth (caller may pass mate via PV;
        # we leave the simple "delivers check" line here).
        best_reasons.append("delivers check with tempo")

    # Fork / multi-attack from best move's destination
    tmp = board_before.copy(stack=False)
    tmp.push(best)
    targets = _attacks_from(tmp, best.to_square, mover_color)
    valuable = [(s, p) for s, p in targets if _pv(p) >= 3]
    if not board_before.is_capture(best) and len(valuable) >= 2:
        names = " + ".join(_pn(p) for _, p in valuable[:3])
        best_reasons.append(f"forks {names}")
    elif not board_before.is_capture(best) and len(valuable) == 1:
        s, p = valuable[0]
        if _pv(best_mover_piece) < _pv(p):
            best_reasons.append(f"attacks the {_pn(p)} on {_sq(s)} with a lower-value piece")

    # ---- Played move motifs ----
    played_reasons: list[str] = []
    board_after = board_before.copy(stack=False)
    board_after.push(played)

    # 1. Did played LEAVE a piece hanging that wasn't hanging before?
    hung_before_set = {sq for sq, _ in _hung_pieces(board_before, mover_color)}
    hung_after = _hung_pieces(board_after, mover_color)
    new_hung = [(s, p) for s, p in hung_after if s not in hung_before_set]
    if new_hung:
        # Limit to top-3 most valuable to keep caption short.
        new_hung.sort(key=lambda sp: -_pv(sp[1]))
        names = ", ".join(f"{_pn(p)} on {_sq(s)}" for s, p in new_hung[:2])
        played_reasons.append(f"hangs the {names}")

    # 2. Played piece itself ends up on an attacked square (en prise).
    moved_after = board_after.piece_at(played.to_square)
    if moved_after is not None:
        attackers = board_after.attackers(not mover_color, played.to_square)
        defenders = board_after.attackers(mover_color, played.to_square)
        if attackers:
            min_att_val = min(_pv(board_after.piece_at(a)) for a in attackers)
            if (not defenders and _pv(moved_after) > 0) or (min_att_val < _pv(moved_after)):
                # Skip if already mentioned via hung detection
                if not any(played.to_square == s for s, _ in new_hung):
                    played_reasons.append(f"leaves the {_pn(moved_after)} en prise on {_sq(played.to_square)}")

    # 3. Missed a free capture: best captures something, played doesn't.
    if board_before.is_capture(best) and not board_before.is_capture(played):
        cap_sq = board_before.ep_square if board_before.is_en_passant(best) else best.to_square
        cap_piece = board_before.piece_at(cap_sq)
        if cap_piece is not None:
            played_reasons.append(f"misses the {_pn(cap_piece)} on {_sq(cap_sq)}")

    # 4. Walks into check vs. avoidable.
    if board_after.is_check():
        # Only mention if the played move's own side is in check after move
        # (this would only happen for moves that didn't resolve a check,
        # which python-chess wouldn't allow; but include for safety).
        played_reasons.append("leaves the king in check")

    # ---- Generic cp-loss fallback ----
    if not played_reasons:
        if cp_loss >= 200:
            played_reasons.append(f"loses about {cp_loss/100:.1f} pawns of evaluation")
        elif cp_loss >= 100:
            played_reasons.append(f"costs about {cp_loss/100:.1f} pawns")
        elif cp_loss >= 50:
            played_reasons.append(f"gives up about {cp_loss/100:.1f} pawn of edge")
        elif cp_loss > 0:
            played_reasons.append("isn't the engine's top choice")

    if not best_reasons:
        # Use mover-side eval-after-best if we can infer it (~= prev_eval).
        if played_eval_after is not None:
            played_from_mover = played_eval_after if mover_color == chess.WHITE else -played_eval_after
            if cp_loss >= 100:
                best_reasons.append("keeps the position stable instead of conceding material/initiative")
            elif played_from_mover < 0:
                best_reasons.append("avoids worsening the position")
            else:
                best_reasons.append("preserves the advantage")
        else:
            best_reasons.append("is the engine's top choice")

    out["best_reason"] = "; ".join(best_reasons[:2])
    out["played_reason"] = "; ".join(played_reasons[:2])
    return out
