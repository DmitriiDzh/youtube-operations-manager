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

REM Auto-update: only when this is an actual git checkout of the repository (this device's own
REM origin, which the operator already controls -- never a standalone published\<version>\
REM release copy, which has no .git and is intentionally left untouched here, see
REM docs\RELEASE_LAYOUT.md section 1's "no installer or auto-updater" scope note and AGENTS.md section K.4).
if not exist ".git" goto :skip_update
where git >nul 2>nul
if errorlevel 1 goto :skip_update

set "IS_DIRTY="
for /f "delims=" %%i in ('git status --porcelain 2^>nul') do (
  set "IS_DIRTY=1"
  goto :dirty_check_done
)
:dirty_check_done
if defined IS_DIRTY (
  echo [WARN] Uncommitted local changes detected in this git checkout ^-^- skipping auto-update
  echo so your work isn't touched. Commit or stash your changes, then re-run start.bat to pick
  echo up the latest version automatically.
  goto :skip_update
)

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "CURRENT_BRANCH=%%b"
if "%CURRENT_BRANCH%"=="" goto :skip_update
if "%CURRENT_BRANCH%"=="HEAD" goto :skip_update
git remote get-url origin >nul 2>nul
if errorlevel 1 goto :skip_update

echo Checking for updates on '%CURRENT_BRANCH%'...
for /f "delims=" %%r in ('git rev-parse HEAD') do set "BEFORE_REV=%%r"
call git pull --ff-only origin %CURRENT_BRANCH%
if errorlevel 1 (
  echo [WARN] Could not fast-forward to the latest '%CURRENT_BRANCH%' ^(offline, or local
  echo history has diverged^) ^-^- continuing with the current version.
  goto :skip_update
)
for /f "delims=" %%r in ('git rev-parse HEAD') do set "AFTER_REV=%%r"
if "%BEFORE_REV%"=="%AFTER_REV%" (
  echo Already up to date.
  goto :skip_update
)
echo Update found ^-^- installing dependencies and rebuilding before starting...
call npm install
if errorlevel 1 goto :fail
call npm run build
if errorlevel 1 goto :fail

:skip_update

if not exist "node_modules" (
  echo Installing dependencies ^(first run only, this can take a few minutes^)...
  call npm install
  if errorlevel 1 goto :fail
)

if not exist ".next" (
  echo No build found - building the application ^(first run, or after a manual update.bat^)...
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
