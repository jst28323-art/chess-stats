@echo off
REM Single entry point for the "ChessStats" Scheduled Task at logon.
REM Starts the backend (idempotent) then the tunnel (idempotent, waits for backend).
setlocal
cd /d "%~dp0\.."
call scripts\autostart_backend.cmd
call scripts\autostart_tunnel.cmd
exit /b 0
