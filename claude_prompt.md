You are Claude Code running on my home PC.

Task: Upgrade my existing repo `/workspace/chess-stats` from browser-only eval to a hybrid architecture:
- Frontend still static (GitHub Pages compatible).
- Backend + Stockfish analysis + DB fully local on my home machine.
- No paid cloud services.
- Preserve and improve current UI.
- Make analysis reliable and avoid timeout/fallback artifacts.

IMPORTANT: Execute end-to-end with minimal questions. If assumptions are needed, choose sane defaults and continue.

========================================
GOALS
========================================
1) Keep static frontend for GitHub Pages.
2) Add local backend service that:
   - fetches Chess.com archives,
   - queues game analysis jobs,
   - runs Stockfish server-side (home CPU),
   - stores per-game/per-ply results in local DB,
   - serves results via REST API.
3) Frontend should prefer backend results when available.
4) If backend unavailable, frontend should still run with existing behavior (degraded mode).
5) Add robust progress/status UI so I can see:
   - backend connected/disconnected
   - games queued / running / completed / failed
   - analysis source (backend vs local fallback)
6) Add full game-review panel:
   - board at each move,
   - eval per ply,
   - best move,
   - PV line,
   - captured piece,
   - prev/next controls.
7) Persist everything locally on this machine.
8) Commit all changes, merge to `main`, and push.

========================================
CONSTRAINTS
========================================
- Repo path: `/workspace/chess-stats`
- Do not remove existing core dashboard features.
- Prefer Python backend (FastAPI + SQLite) unless repo strongly suggests otherwise.
- Use local Stockfish binary for backend analysis (install if needed).
- Keep API and storage self-hosted on this machine.
- Keep frontend deployable to GitHub Pages.
- Include clear docs for running backend and optional LAN/public exposure.

========================================
IMPLEMENTATION PLAN
========================================
A) Inspect current repo and existing frontend behavior.
B) Add backend in `backend/`:
   - FastAPI app
   - SQLite DB (e.g. `backend/data/chessstats.db`)
   - Job queue + worker loop
   - Stockfish adapter
   - API endpoints:
     - GET /health
     - POST /api/analyze/player/{username}
       body: {range, timeClass, limit, forceRecompute}
     - GET /api/jobs/{job_id}
     - GET /api/player/{username}/games?range=&timeClass=&limit=
     - GET /api/game/{game_id}/analysis
     - GET /api/player/{username}/summary?range=&timeClass=&limit=
   - deterministic cache key by game URL + engine profile.
C) Add Stockfish analysis schema:
   - game table, ply table, analysis table, job table.
   - per ply: played move, eval cp, bestmove, pv, fen, capture, confidence.
D) Add resilient analysis logic:
   - no browser worker timeouts in backend path.
   - bounded but generous per-position think time.
   - retry per position.
   - mark true failure reasons.
E) Frontend integration:
   - Add backend base URL setting (default `http://<local-ip>:8787` or `http://localhost:8787`).
   - “Connect backend” indicator.
   - Start analysis job from UI.
   - Poll job status.
   - Use backend-provided analysis for charts/feed/details.
   - keep old local mode only as fallback if backend unreachable.
F) Improve review UI:
   - board rendering at each ply
   - eval chart
   - best move + PV
   - captures and move navigation
G) Docs:
   - Update README with:
     - local backend setup
     - launching service
     - running frontend
     - configuring backend URL in frontend
     - optional reverse proxy/tunnel if I want remote access
H) Verification:
   - Run backend locally.
   - Analyze at least a small sample (e.g., 10 games for user `jst28323`).
   - Verify non-empty per-ply analysis stored.
   - Verify frontend loads backend results and displays move-by-move review.
I) Git:
   - create atomic commits
   - ensure clean working tree
   - merge branch into `main`
   - push `main`

========================================
EXPECTED OUTPUTS
========================================
1) Working local backend + DB + stockfish pipeline.
2) Frontend uses backend analysis when available.
3) Fallback count reflects real failures only.
4) No fake 500/500 artifacts from silent fallback.
5) Full move-by-move review UX with board + best move + PV.
6) Updated README with exact startup commands.
7) Merged into `main` and pushed.

========================================
COMMAND/OPS GUIDELINES
========================================
- Prefer explicit scripts:
  - `backend/requirements.txt`
  - `backend/main.py`
  - `backend/worker.py` (or integrated)
  - `scripts/run_backend.sh`
- Add Makefile targets if helpful:
  - `make backend`
  - `make frontend`
  - `make dev`
- Use uvicorn for API.
- Use structured logging for job status.
- Handle Ctrl+C clean shutdown.

========================================
FINAL STEP
========================================
After push, print:
- backend run command
- frontend run command
- URL to open GitHub Pages
- any one-time local config needed
- short verification checklist I can follow in 2 minutes.
