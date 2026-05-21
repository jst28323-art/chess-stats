# Chess Insights+ Pro Dashboard

Premium-style chess analytics for any Chess.com profile.

The frontend is a static page that runs on GitHub Pages. A small **local
backend** runs FastAPI + SQLite + Stockfish on your home machine and produces
deeper, more reliable analysis than the in-browser engine. The frontend prefers
the backend when reachable and falls back to the browser engine otherwise.

Public dashboard URL: <https://jst28323-art.github.io/chess-stats/>

## What you get

- Public Chess.com game feed with filters: all / 24h / 7d / 30d / 90d, time-class.
- KPI overview and trend charts (rating, volume, W/D/L, opponent strength).
- Move-by-move Stockfish eval per game (centipawn).
- Move classification buckets (best / inaccuracy / mistake / blunder).
- Estimated player accuracy + per-phase eval-loss.
- Weekday/hour activity charts.
- Move review panel: board at every ply, eval, best move, PV line, captures, prev/next nav.
- **Source tag per row** — `B` when backend analysis was used, `L` when local.

## Architecture

```
┌─────────────────────────┐        ┌──────────────────────────────────────┐
│ GitHub Pages frontend   │ HTTP   │ Local backend on your PC             │
│ (index.html + app.js)   │ ─────► │   FastAPI :8787                      │
│                         │ ◄───── │   SQLite (backend/data/chessstats.db)│
│ Browser stockfish.js    │        │   Stockfish 17.x (server-side)       │
│ as fallback             │        │   Job queue worker (background)      │
└─────────────────────────┘        └──────────────────────────────────────┘
```

`https://*.github.io/...` is allowed to call `http://localhost:8787` because
browsers treat `localhost` as a secure context. No tunnel or HTTPS cert needed
for the on-machine flow.

## Run the backend (Windows)

```cmd
scripts\run_backend.cmd
```

On first run this creates `backend\.venv`, installs `backend\requirements.txt`,
and launches `uvicorn backend.main:app --host 127.0.0.1 --port 8787`.

Stockfish: download a portable binary (no install needed). The backend
auto-discovers it from:

1. `STOCKFISH_PATH` environment variable
2. `stockfish.exe` on `PATH`
3. `backend\bin\stockfish.exe` (recommended portable location)
4. `C:\stockfish\stockfish.exe`, `C:\Program Files\Stockfish\stockfish.exe`

Recommended portable install:

```cmd
mkdir backend\bin
curl -L -o sf.zip https://github.com/official-stockfish/Stockfish/releases/download/sf_17.1/stockfish-windows-x86-64-avx2.zip
tar -xf sf.zip
move stockfish\stockfish-windows-x86-64-avx2.exe backend\bin\stockfish.exe
del sf.zip
```

(Use `stockfish-windows-x86-64-modern.zip` if your CPU does not support AVX2.)

## Run the backend (macOS / Linux)

```bash
./scripts/run_backend.sh
```

`brew install stockfish` (macOS) or `apt install stockfish` (Debian/Ubuntu)
puts the binary on `PATH` where the backend will find it automatically.

## Run the frontend locally (optional)

```cmd
scripts\run_frontend.cmd
```

Then open <http://localhost:8000>. The published GitHub Pages copy works too;
the only difference is whether app.js is loaded from `localhost` or from
`*.github.io`. Both will talk to `http://localhost:8787` for the backend.

## Configuring the backend URL in the UI

The toolbar has a **Backend URL** input. Defaults to `http://localhost:8787`
and persists in `localStorage`. The chip beside it shows:

- `Backend: online • sf_d14_mt250_v1` — analysis will run server-side
- `Backend: online but stockfish missing` — backend is up but no engine binary
- `Backend: offline` — frontend falls back to the browser engine

The **Prefer backend** checkbox lets you force local-only without restarting
the backend.

## API surface (local)

| Method | Path | Notes |
|--------|------|-------|
| GET    | `/health`                                  | engine status + DB path + queue counts |
| POST   | `/api/analyze/player/{username}`           | body `{range,timeClass,limit,forceRecompute}` → `{job_id}` |
| GET    | `/api/jobs/{job_id}`                       | poll progress / completion / error |
| GET    | `/api/player/{username}/games`             | filtered games + cached engine analysis |
| GET    | `/api/game/{game_id}/analysis`             | full per-ply data (FEN, eval, best, PV, capture) |
| GET    | `/api/player/{username}/summary`           | aggregate KPIs |

Analyses are keyed on `(game_id, engine_profile)` where the profile is
deterministic from depth + movetime, so re-running a job is free if the engine
config did not change.

## Exposing the backend beyond your PC (optional)

The backend binds to `127.0.0.1` and is **not** reachable from other devices
by default. If you want to use the dashboard from your phone:

- Bind to your LAN IP: `--host 0.0.0.0 --port 8787` (edit `scripts/run_backend.cmd`).
- Or tunnel an HTTPS URL with `cloudflared tunnel --url http://localhost:8787`
  and paste that URL into the **Backend URL** field. (Mixed-content rules apply
  to non-`localhost` HTTP endpoints — use HTTPS for remote access.)

## Repo layout

```
chess-stats/
├── index.html                  static frontend entry
├── app.js                      frontend logic (backend-first, local fallback)
├── stockfish.js                browser stockfish for fallback
├── backend/
│   ├── main.py                 FastAPI app + routes + CORS
│   ├── db.py                   SQLite schema + helpers
│   ├── chesscom.py             Chess.com archive fetcher
│   ├── stockfish_adapter.py    UCI session (auto-discovery)
│   ├── worker.py               background job processor
│   ├── requirements.txt
│   ├── bin/                    stockfish binary (gitignored)
│   └── data/                   SQLite db (gitignored)
└── scripts/
    ├── run_backend.cmd
    ├── run_backend.sh
    └── run_frontend.cmd
```
