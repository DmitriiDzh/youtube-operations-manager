@echo off
setlocal enabledelayedexpansion
echo Stopping YouTube Operations Manager ^(port 3000^)...

REM Match ":3000 " (with the trailing space netstat pads columns with) rather than plain ":3000",
REM which would also match an unrelated process on ports 30000-30009 and force-kill the wrong PID.
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":3000 " ^| findstr LISTENING') do (
  set FOUND=1
  echo Stopping process id %%p ...
  taskkill /PID %%p /F >nul 2>nul
)

REM Also close the launcher's own wrapper window (and the node process tree under it) by title,
REM in case it is still open with a shell prompt after the server process above was stopped.
taskkill /FI "WINDOWTITLE eq YouTube Operations Manager*" /T /F >nul 2>nul

if "!FOUND!"=="0" (
  echo Nothing is listening on port 3000 - the application does not appear to be running.
) else (
  echo Done.
)

REM update.bat calls this script with /noconfirm during an automated update - skip the pause then.
if /i not "%~1"=="/noconfirm" pause
