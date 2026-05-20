# Chess Insights+ Dashboard

Features:
- Full game feed from Chess.com archives with filters: last 24h, 7d, 30d, 90d, all.
- Click any game for full move-by-move engine eval (Stockfish in-browser).
- Eval graph across the entire game (centipawn trend by ply).
- Engine quality ratings for both players per game (0-100 scale from average eval swings).
- Existing KPI trends and time-control analytics.

## Account connection

No private OAuth is required. Enter a Chess.com username (default `jst28323`) and the app pulls public game archives and stats.

## Run

Open `index.html` in a browser with internet access, or serve locally:

```bash
python3 -m http.server
```
