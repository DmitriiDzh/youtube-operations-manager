@echo off
setlocal enabledelayedexpansion
echo Stopping YouTube Operations Manager ^(port 3000^)...

set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
  set FOUND=1
  echo Stopping process id %%p ...
  taskkill /PID %%p /F >nul 2>nul
)

if "!FOUND!"=="0" (
  echo Nothing is listening on port 3000 - the application does not appear to be running.
) else (
  echo Done.
)

echo If a window titled "YouTube Operations Manager" is still open, you can also just close it.
pause
