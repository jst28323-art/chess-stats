"""Chess.com archive fetcher."""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

import httpx

log = logging.getLogger(__name__)

BASE = "https://api.chess.com/pub/player"
_DRAW_RESULTS = {"agreed", "repetition", "stalemate", "timevsinsufficient", "insufficient", "50move"}


def game_id_from_url(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]


def _range_start(range_key: str) -> int:
    now = int(time.time())
    days = {"24h": 1, "7d": 7, "30d": 30, "90d": 90}.get(range_key)
    return 0 if days is None else now - days * 86400


async def fetch_all_games(username: str) -> list[dict[str, Any]]:
    headers = {"User-Agent": "chess-insights-plus/0.1 (+local backend)"}
    async with httpx.AsyncClient(timeout=30.0, headers=headers) as client:
        idx = (await client.get(f"{BASE}/{username}/games/archives")).json()
        urls: list[str] = idx.get("archives", [])
        games: list[dict[str, Any]] = []
        for u in urls:
            try:
                r = await client.get(u)
                r.raise_for_status()
                games.extend(r.json().get("games", []) or [])
            except Exception as e:  # noqa: BLE001
                log.warning("archive fetch failed %s: %s", u, e)
        return games


def filter_games(
    games: list[dict[str, Any]],
    username: str,
    range_key: str,
    time_class: str,
    limit_n: int,
) -> list[dict[str, Any]]:
    start = _range_start(range_key)
    u = username.lower()
    out = [
        g
        for g in games
        if g.get("rated")
        and g.get("time_class")
        and g.get("end_time", 0) >= start
        and (time_class == "all" or g.get("time_class") == time_class)
        and (
            (g.get("white", {}).get("username") or "").lower() == u
            or (g.get("black", {}).get("username") or "").lower() == u
        )
    ]
    out.sort(key=lambda g: g.get("end_time", 0))
    return out[-int(limit_n):]


def to_row(g: dict[str, Any], username: str) -> dict[str, Any]:
    url = g.get("url") or ""
    w = g.get("white", {}) or {}
    b = g.get("black", {}) or {}
    return {
        "game_id": game_id_from_url(url),
        "game_url": url,
        "username": username.lower(),
        "end_time": int(g.get("end_time", 0) or 0),
        "time_class": g.get("time_class"),
        "rated": 1 if g.get("rated") else 0,
        "white_user": w.get("username"),
        "white_rating": w.get("rating"),
        "white_result": w.get("result"),
        "black_user": b.get("username"),
        "black_rating": b.get("rating"),
        "black_result": b.get("result"),
        "pgn": g.get("pgn"),
        "fetched_at": time.time(),
    }


def perspective(row: dict[str, Any], username: str) -> dict[str, Any]:
    """Return who-is-me and the outcome tag from the user's perspective."""
    u = username.lower()
    me_white = (row.get("white_user") or "").lower() == u
    if me_white:
        me_user, me_rating, me_result = row["white_user"], row["white_rating"], row["white_result"]
        opp_user, opp_rating, opp_result = row["black_user"], row["black_rating"], row["black_result"]
    else:
        me_user, me_rating, me_result = row["black_user"], row["black_rating"], row["black_result"]
        opp_user, opp_rating, opp_result = row["white_user"], row["white_rating"], row["white_result"]
    outcome = "Win" if me_result == "win" else ("Draw" if me_result in _DRAW_RESULTS else "Loss")
    return {
        "me_white": me_white,
        "me_user": me_user,
        "me_rating": me_rating,
        "me_result": me_result,
        "opp_user": opp_user,
        "opp_rating": opp_rating,
        "opp_result": opp_result,
        "outcome": outcome,
    }
