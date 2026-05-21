"""ECO opening identification via the Lichess chess-openings dataset.

On first use, downloads a.tsv...e.tsv from
https://github.com/lichess-org/chess-openings and caches the combined file at
backend/data/openings.tsv. ~3000 entries; max depth ~15 plies. Falls back
gracefully (book detection disabled) if the download fails.
"""
from __future__ import annotations

import csv
import logging
import re
import threading
from pathlib import Path
from typing import Optional

import chess
import httpx

log = logging.getLogger(__name__)

LICHESS_URLS = [
    "https://raw.githubusercontent.com/lichess-org/chess-openings/master/a.tsv",
    "https://raw.githubusercontent.com/lichess-org/chess-openings/master/b.tsv",
    "https://raw.githubusercontent.com/lichess-org/chess-openings/master/c.tsv",
    "https://raw.githubusercontent.com/lichess-org/chess-openings/master/d.tsv",
    "https://raw.githubusercontent.com/lichess-org/chess-openings/master/e.tsv",
]

CACHE_PATH = Path(__file__).resolve().parent / "data" / "openings.tsv"


class OpeningDB:
    def __init__(self) -> None:
        self.by_prefix: dict[tuple[str, ...], tuple[str, str]] = {}
        self.max_depth: int = 0
        self._loaded: bool = False
        self._lock = threading.Lock()

    def state(self) -> dict:
        return {
            "loaded": self._loaded,
            "entries": len(self.by_prefix),
            "max_depth": self.max_depth,
            "cache_path": str(CACHE_PATH),
        }

    def ensure_loaded(self) -> None:
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            self._load()
            self._loaded = True

    def _download(self) -> None:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        chunks: list[str] = []
        with httpx.Client(timeout=20.0, headers={"User-Agent": "chess-insights-plus/0.1"}) as client:
            for url in LICHESS_URLS:
                try:
                    r = client.get(url)
                    r.raise_for_status()
                    chunks.append(r.text)
                except Exception as e:  # noqa: BLE001
                    log.warning("openings: fetch failed %s: %s", url, e)
        if not chunks:
            return
        # Keep only the first header line, then append data from each file.
        out: list[str] = []
        header_taken = False
        for c in chunks:
            lines = c.splitlines()
            if not lines:
                continue
            if not header_taken:
                out.append(lines[0])
                header_taken = True
            out.extend(lines[1:])
        CACHE_PATH.write_text("\n".join(out) + "\n", encoding="utf-8")
        log.info("openings: downloaded %d lines to %s", len(out), CACHE_PATH)

    def _load(self) -> None:
        if not CACHE_PATH.exists():
            log.info("openings: cache missing, downloading from lichess-org/chess-openings")
            try:
                self._download()
            except Exception as e:  # noqa: BLE001
                log.warning("openings: download error: %s", e)
        if not CACHE_PATH.exists():
            log.warning("openings: no cache; book detection disabled")
            return
        move_num_re = re.compile(r"\d+\.{1,3}")
        try:
            with CACHE_PATH.open("r", encoding="utf-8") as f:
                reader = csv.DictReader(f, delimiter="\t")
                count = 0
                skipped = 0
                for row in reader:
                    name = (row.get("name") or "").strip()
                    eco = (row.get("eco") or "").strip()
                    # Some forks of the dataset ship a "uci" column directly.
                    uci_str = (row.get("uci") or "").strip()
                    parts: Optional[tuple[str, ...]] = None
                    if uci_str:
                        parts = tuple(uci_str.split())
                    else:
                        pgn = (row.get("pgn") or "").strip()
                        if name and pgn:
                            cleaned = move_num_re.sub(" ", pgn).strip()
                            board = chess.Board()
                            ucis: list[str] = []
                            ok = True
                            for token in cleaned.split():
                                if not token:
                                    continue
                                try:
                                    mv = board.parse_san(token)
                                except Exception:
                                    ok = False
                                    break
                                ucis.append(mv.uci())
                                board.push(mv)
                            if ok and ucis:
                                parts = tuple(ucis)
                    if not name or not parts:
                        skipped += 1
                        continue
                    # If two openings share the same prefix, the last one wins;
                    # since the TSV is sorted shortest-first this leaves us
                    # with the more specific name for that exact sequence.
                    self.by_prefix[parts] = (eco, name)
                    if len(parts) > self.max_depth:
                        self.max_depth = len(parts)
                    count += 1
                log.info("openings: loaded %d entries (max depth %d, %d skipped)",
                         count, self.max_depth, skipped)
        except Exception as e:  # noqa: BLE001
            log.warning("openings: parse failed: %s", e)

    def identify(self, ucis: list[str]) -> dict:
        """Return {eco, name, last_ply, next_uci} for the longest prefix match.

        last_ply is 1-indexed (number of plies that are still 'in book').
        next_uci is one candidate continuation that would extend the opening
        further, or None if no continuation exists in the DB.
        """
        self.ensure_loaded()
        empty = {"eco": None, "name": None, "last_ply": 0, "next_uci": None}
        if not self.by_prefix or not ucis:
            return empty
        match_len = 0
        match_meta: Optional[tuple[str, str]] = None
        # Scan from longest possible match down to length 1.
        for n in range(min(len(ucis), self.max_depth), 0, -1):
            key = tuple(ucis[:n])
            if key in self.by_prefix:
                match_meta = self.by_prefix[key]
                match_len = n
                break
        if match_meta is None:
            return empty
        prefix = tuple(ucis[:match_len])
        next_uci: Optional[str] = None
        for key in self.by_prefix:
            if len(key) == match_len + 1 and key[:match_len] == prefix:
                next_uci = key[match_len]
                break
        return {"eco": match_meta[0] or None, "name": match_meta[1], "last_ply": match_len, "next_uci": next_uci}


opening_db = OpeningDB()
