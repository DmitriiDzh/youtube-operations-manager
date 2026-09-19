@echo off
setlocal
cd /d "%~dp0..\.."

echo === YouTube Operations Manager - Windows launcher ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH.
  echo Install Node.js 20 LTS or newer from https://nodejs.org and re-run this script.
  pause
  exit /b 1
)

if not exist ".env.local" (
  echo [ERROR] .env.local not found in "%cd%".
  echo Copy .env.example to .env.local and fill in your Google OAuth values first ^-^- see docs\getting-started.md.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies ^(first run only, this can take a few minutes^)...
  call npm install
  if errorlevel 1 goto :fail
)

if not exist ".next" (
  echo No build found - building the application ^(first run, or after running update.bat^)...
  call npm run build
  if errorlevel 1 goto :fail
)

echo Starting YouTube Operations Manager on http://localhost:3000 ...
start "YouTube Operations Manager" cmd /k "npm run start"

REM Give the server a moment to come up before opening the browser.
timeout /t 4 >nul
start http://localhost:3000

echo.
echo The application is running in a separate window titled "YouTube Operations Manager".
echo   - To stop it safely, run stop.bat ^(or just close that window^).
echo   - Your data is stored under %%APPDATA%%\YouTubeOperationsManager\, not in this folder -
echo     it is not affected by replacing these program files later.
exit /b 0

:fail
echo.
echo [ERROR] Setup failed - see the output above for details.
pause
exit /b 1
