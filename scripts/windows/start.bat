@echo off
setlocal enabledelayedexpansion
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

REM Rebuild-staleness check. This script no longer touches the network, the remote, or the
REM working tree in any way (it previously ran `git pull --ff-only` itself before this check --
REM removed 2026-09-21 at the project owner's explicit request: "за актуальностью гита я буду
REM следить сам" -- keeping git entirely up to the operator, not this script).
REM
REM In an actual git checkout of the repository, compare the currently checked-out commit
REM against a marker file recording which commit `.next` was actually built from, so a build the
REM operator did on an earlier commit (e.g. before their own `git pull`) is detected and
REM rebuilt automatically -- rather than relying on ".next merely exists" as the only signal,
REM which cannot tell a stale build apart from a current one. A standalone published\<version>\
REM release copy has no `.git` and no commit to compare against -- `update.bat` remains its one,
REM explicit, human-triggered rebuild step (docs\RELEASE_LAYOUT.md §1, AGENTS.md §K.4).
set "BUILD_MARKER=.next-build-commit.txt"
set "CURRENT_REV="
if exist ".git" (
  where git >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%r in ('git rev-parse HEAD 2^>nul') do set "CURRENT_REV=%%r"
  )
)

set "NEED_BUILD="
if not exist ".next" set "NEED_BUILD=1"

if defined CURRENT_REV (
  set "BUILT_REV="
  if exist "%BUILD_MARKER%" set /p BUILT_REV=<"%BUILD_MARKER%"
  if not "%CURRENT_REV%"=="!BUILT_REV!" set "NEED_BUILD=1"
)

if defined NEED_BUILD (
  echo Building the application ^(no build found, or the checked-out commit changed since the last build^)...
  call npm run build
  if errorlevel 1 goto :fail
  if defined CURRENT_REV (
    > "%BUILD_MARKER%" echo !CURRENT_REV!
  )
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
