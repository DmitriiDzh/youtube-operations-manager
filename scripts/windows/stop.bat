@echo off
REM Stops the running server -- but never in the middle of an export/import/schema migration:
REM an interrupted one is exactly what leaves a stuck operation lock. Same principles as
REM scripts/macos/stop.sh (keep the two in step): (1) find the listener on port 3000, (2) wait for
REM any RUNNING operation to finish (`operation-lock wait-idle`; refuse to stop if it does not
REM within 2 minutes), (3) stop the process, (4) confirm the port is actually free. Exit code 0 =
REM nothing left running, 1 = not stopped (callers such as start.bat/update.bat must not go on).
REM
REM `cd` happens BEFORE delayed expansion is enabled: this project's folder name starts with "!",
REM which delayed expansion would strip from the path (see start.bat's own note).
setlocal
cd /d "%~dp0..\.."
setlocal enabledelayedexpansion
echo Stopping YouTube Operations Manager ^(port 3000^)...

REM Match ":3000 " (with the trailing space netstat pads columns with) rather than plain ":3000",
REM which would also match an unrelated process on ports 30000-30009 and force-kill the wrong PID.
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":3000 " ^| findstr LISTENING') do set FOUND=1

set RC=0
if "!FOUND!"=="0" (
  echo Nothing is listening on port 3000 - the application does not appear to be running.
  REM Still close a leftover launcher window (see below).
  taskkill /FI "WINDOWTITLE eq YouTube Operations Manager*" /T /F >nul 2>nul
  goto :finish
)

echo Checking that no export, import or database migration is running...
call npm run --silent operation-lock -- wait-idle --timeout 120
if errorlevel 1 (
  echo [ERROR] The application was NOT stopped: a running operation did not finish ^(or could not be checked^).
  echo         Stopping it now could leave a stuck lock. Wait and try again, or see the /recovery page.
  set RC=1
  goto :finish
)

REM FO-MSG-0013: stopping terminates this computer's running pods and fails their queued jobs, so a running media session
REM blocks stopping unless the script is called with --force.
if /I not "%~1"=="--force" (
  echo Checking that no media session is running on this computer...
  call npm run --silent operation-lock -- media-idle
  if errorlevel 1 (
    echo [ERROR] The application was NOT stopped: a media session is running here ^(or this could not be checked^).
    echo         Stopping now would terminate its pod and fail its queued jobs. Wait until it finishes, stop it in
    echo         Production, or run stop.bat --force.
    set RC=1
    goto :finish
  )
)

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":3000 " ^| findstr LISTENING') do (
  echo Stopping process id %%p ...
  taskkill /PID %%p /F >nul 2>nul
)

REM Also close the launcher's own wrapper window (and the node process tree under it) by title,
REM in case it is still open with a shell prompt after the server process above was stopped.
taskkill /FI "WINDOWTITLE eq YouTube Operations Manager*" /T /F >nul 2>nul

REM Confirm the port is really free (up to ~10s) so a start right after this cannot hit a server
REM that is still shutting down.
set TRIES=0
:waitport
set "STILL="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":3000 " ^| findstr LISTENING') do set STILL=1
if not defined STILL goto :portfree
set /a TRIES+=1
if !TRIES! geq 10 (
  echo [ERROR] Port 3000 is still in use after waiting - the application may not have stopped.
  set RC=1
  goto :finish
)
timeout /t 1 >nul
goto :waitport
:portfree
echo Done - port 3000 is free.

:finish
REM start.bat/update.bat call this script with /noconfirm during an automated run - skip the pause then.
if /i not "%~1"=="/noconfirm" pause
exit /b !RC!
