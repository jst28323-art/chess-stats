"""Stockfish UCI adapter for the backend.

Uses python-chess's engine interface. Auto-discovers the stockfish binary via:
  1. STOCKFISH_PATH env var
  2. A list of common install locations (Windows + POSIX), incl. the bundled
     backend/bin/stockfish.exe
  3. shutil.which("stockfish"), restricted to real executables

The bundled binary is checked before shutil.which on purpose: on Windows the
default PATHEXT includes .JS, so shutil.which("stockfish") will match the
repo-root browser engine stockfish.js when the backend's cwd is the repo root.
That .js file is not a runnable UCI engine and raises WinError 193 ("%1 is not
a valid Win32 application"), so it must never win path resolution.
"""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

import chess
import chess.engine

log = logging.getLogger(__name__)


_COMMON_WIN_PATHS = [
    r"C:\stockfish\stockfish.exe",
    r"C:\Program Files\Stockfish\stockfish.exe",
    r"C:\Program Files (x86)\Stockfish\stockfish.exe",
    r"C:\tools\stockfish\stockfish.exe",
    str(Path.home() / "stockfish" / "stockfish.exe"),
    str(Path(__file__).resolve().parent / "bin" / "stockfish.exe"),
    str(Path(__file__).resolve().parent / "bin" / "stockfish-windows-x86-64-avx2.exe"),
]
_COMMON_POSIX_PATHS = [
    "/usr/local/bin/stockfish",
    "/usr/bin/stockfish",
    "/opt/homebrew/bin/stockfish",
    str(Path.home() / ".local" / "bin" / "stockfish"),
    str(Path(__file__).resolve().parent / "bin" / "stockfish"),
]


def _is_runnable_engine(path: str) -> bool:
    """Reject non-executable matches. On Windows, shutil.which can return a
    script (e.g. stockfish.js via PATHEXT containing .JS); only native
    executables can be launched as a UCI engine."""
    if os.name == "nt":
        return Path(path).suffix.lower() in {".exe", ".com"}
    return True


def find_stockfish() -> str | None:
    env = os.environ.get("STOCKFISH_PATH")
    if env and Path(env).exists():
        return env
    # Explicit candidates (incl. bundled bin/stockfish.exe) BEFORE shutil.which,
    # so the repo-root stockfish.js can never be picked up via PATHEXT .JS.
    candidates = _COMMON_WIN_PATHS if os.name == "nt" else _COMMON_POSIX_PATHS
    for p in candidates:
        if Path(p).exists():
            return p
    # Last resort: PATH lookup, guarded so a non-executable match is ignored.
    which = shutil.which("stockfish") or shutil.which("stockfish.exe")
    if which and _is_runnable_engine(which):
        return which
    return None


def stockfish_ok() -> tuple[bool, str | None, str | None]:
    """Return (ok, path, error)."""
    path = find_stockfish()
    if not path:
        return False, None, "stockfish binary not found"
    try:
        eng = chess.engine.SimpleEngine.popen_uci(path)
        try:
            return True, path, None
        finally:
            eng.quit()
    except Exception as e:  # noqa: BLE001
        return False, path, f"{type(e).__name__}: {e}"


class StockfishSession:
    """Persistent UCI session reused across positions in a single job.

    Keeps the engine process alive between positions for speed, but tears it
    down cleanly on close().
    """

    def __init__(self, path: str, threads: int = 2, hash_mb: int = 256) -> None:
        self.path = path
        self.engine = chess.engine.SimpleEngine.popen_uci(path)
        try:
            self.engine.configure({"Threads": threads, "Hash": hash_mb})
        except Exception as e:  # noqa: BLE001
            log.warning("could not configure stockfish: %s", e)

    def analyse(
        self,
        board: chess.Board,
        depth: int = 14,
        movetime_ms: int = 250,
    ) -> dict:
        """Analyse a board and return a normalized dict.

        Returns: {eval_cp, mate, bestmove_uci, bestmove_san, pv_uci, pv_san}
        Eval is from White's perspective in centipawns, clamped to +/-1000 like
        the existing frontend.
        """
        # Terminal positions short-circuit before stockfish. python-chess reports
        # Mate(0) for "side to move is mated", whose sign is lost; trusting it
        # would flip the eval bar at checkmate. Derive the winner from board
        # state directly: the side whose turn it is has just been mated.
        if board.is_checkmate():
            winner_is_white = (board.turn == chess.BLACK)
            return {
                "eval_cp": 1000 if winner_is_white else -1000,
                "mate": 0,
                "bestmove_uci": None,
                "bestmove_san": None,
                "pv_uci": "",
                "pv_san": "",
            }
        if board.is_stalemate() or board.is_insufficient_material():
            return {
                "eval_cp": 0,
                "mate": None,
                "bestmove_uci": None,
                "bestmove_san": None,
                "pv_uci": "",
                "pv_san": "",
            }
        limit = chess.engine.Limit(time=movetime_ms / 1000.0, depth=depth)
        info = self.engine.analyse(board, limit, multipv=1)
        if isinstance(info, list):
            info = info[0] if info else {}
        score = info.get("score")
        eval_cp: int | None = None
        mate: int | None = None
        if score is not None:
            pov = score.white()
            if pov.is_mate():
                m = pov.mate()
                mate = int(m) if m is not None else None
                if mate is not None and mate > 0:
                    eval_cp = 1000
                elif mate is not None and mate < 0:
                    eval_cp = -1000
                else:
                    # Mate(0) reached outside the is_checkmate() short-circuit
                    # above is unusual; fall back to "side-to-move just mated"
                    # semantics — opposite side wins.
                    eval_cp = -1000 if board.turn == chess.WHITE else 1000
            else:
                cp = pov.score()
                if cp is None:
                    eval_cp = 0
                else:
                    eval_cp = max(-1000, min(1000, int(cp)))
        pv = info.get("pv") or []
        bestmove_uci = pv[0].uci() if pv else None
        try:
            pv_san_list: list[str] = []
            tmp = board.copy(stack=False)
            for mv in pv[:8]:
                pv_san_list.append(tmp.san(mv))
                tmp.push(mv)
            bestmove_san = pv_san_list[0] if pv_san_list else None
            pv_san = " ".join(pv_san_list)
        except Exception:
            bestmove_san = None
            pv_san = " ".join(m.uci() for m in pv[:8])
        return {
            "eval_cp": eval_cp,
            "mate": mate,
            "bestmove_uci": bestmove_uci,
            "bestmove_san": bestmove_san,
            "pv_uci": " ".join(m.uci() for m in pv[:8]),
            "pv_san": pv_san,
        }

    def close(self) -> None:
        try:
            self.engine.quit()
        except Exception:  # noqa: BLE001
            try:
                self.engine.close()
            except Exception:
                pass
