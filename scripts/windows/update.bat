@echo off
setlocal
cd /d "%~dp0..\.."

echo === YouTube Operations Manager - update ^(rebuild after replacing program files^) ===
echo.
echo This only rebuilds the application in this folder. Your database and settings live under
echo %%APPDATA%%\YouTubeOperationsManager\ and are never touched by this script.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install Node.js 20 LTS or newer from https://nodejs.org.
  pause
  exit /b 1
)

echo Stopping any running instance first...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
  taskkill /PID %%p /F >nul 2>nul
)

echo Installing dependencies for this version...
call npm install
if errorlevel 1 goto :fail

echo Rebuilding...
call npm run build
if errorlevel 1 goto :fail

echo.
echo Update complete. Run start.bat to launch the updated application.
echo On first launch after an update, the application checks its database schema version and
echo applies any needed migration automatically, after taking its own backup - see
echo docs\RELEASE_LAYOUT.md and docs\TECHNICAL_DEBT.md for detail. It never silently creates a
echo new empty database in place of an existing one.
pause
exit /b 0

:fail
echo [ERROR] Update failed - see the output above for details. Your existing installation and
echo data were not modified.
pause
exit /b 1
