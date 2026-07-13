@echo off
REM ==========================================================================
REM  TailorResume v2 - Frontend (React + Vite dev server)
REM  Installs node_modules on first run, then serves on port 5173.
REM  Vite proxies /api -> http://127.0.0.1:8503 (see vite.config.ts),
REM  so start the backend too (run_backend.bat or run.bat).
REM ==========================================================================
setlocal
cd /d "%~dp0frontend"

if not exist "node_modules\" (
    echo [frontend] Installing npm dependencies...
    call npm install
)

echo.
echo [frontend] Starting Vite dev server on http://localhost:5173
echo [frontend] Press Ctrl+C to stop.
echo.
call npm run dev -- --host

endlocal
