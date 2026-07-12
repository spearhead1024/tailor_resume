@echo off
REM ==========================================================================
REM  TailorResume v2 - Backend (FastAPI / uvicorn)
REM  Creates a .venv on first run, installs deps, then serves on port 8503.
REM ==========================================================================
setlocal
cd /d "%~dp0backend"

set "VENV_CREATED="
if not exist ".venv\Scripts\python.exe" (
    echo [backend] Creating virtual environment ^(.venv^)...
    py -3 -m venv .venv || python -m venv .venv
    set "VENV_CREATED=1"
)

call ".venv\Scripts\activate.bat"

if defined VENV_CREATED (
    echo [backend] Installing dependencies from requirements.txt...
    python -m pip install --upgrade pip
    python -m pip install -r requirements.txt
    echo [backend] Installing Windows PDF-export extras ^(requirements-windows.txt^)...
    python -m pip install -r requirements-windows.txt
)

echo.
echo [backend] Starting FastAPI on http://127.0.0.1:8503  ^(API docs: /docs^)
echo [backend] Press Ctrl+C to stop.
echo.
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8503

endlocal
