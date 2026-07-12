@echo off
REM ==========================================================================
REM  TailorResume v2 - Launch backend + frontend in separate windows.
REM ==========================================================================
setlocal

echo Starting TailorResume v2...
echo.

start "TailorResume Backend"  cmd /k "%~dp0run_backend.bat"
start "TailorResume Frontend" cmd /k "%~dp0run_frontend.bat"

echo   Backend  : http://127.0.0.1:8503   ^(API docs: http://127.0.0.1:8503/docs^)
echo   Frontend : http://localhost:5173
echo.
echo Two terminal windows have opened. Close them (or Ctrl+C) to stop.
echo On first run, dependency install may take a minute.
echo.

endlocal
