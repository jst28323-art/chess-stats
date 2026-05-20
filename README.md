# Chess Insights+ Pro Dashboard

This project aims to match top-tier paid-style chess insights as closely as possible using public Chess.com archives + browser-side engine analysis.

## Included features
- Full public game feed with filters: all/24h/7d/30d/90d and time-class filter.
- KPI overview and trend charts (rating, volume, W/D/L, opponent strength).
- Deep game analysis on click with full move-by-move Stockfish eval (centipawn).
- Eval graph through entire game.
- Move classification buckets (best/inaccuracy/mistake/blunder).
- Estimated player accuracy % (you and opponent).
- Opening/middlegame/endgame average eval-loss indicators.
- Weekday/hour activity charts.

## Important note
This is not an official Chess.com premium backend integration. It is a close functional replica using public API data and local engine analysis in your browser.

## Run
```bash
cd /workspace/chess-stats
python3 -m http.server
```
Then open http://localhost:8000
