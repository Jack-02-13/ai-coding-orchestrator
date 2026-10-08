@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or later is required. Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<20)process.exit(1)"
if errorlevel 1 (
  echo Node.js 20 or later is required. Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
if not exist node_modules\jose (
  echo Installing the open-source runtime dependency...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. No AI request was made.
    pause
    exit /b 1
  )
)
start "AI Developer Bridge server" /b node src\server.mjs
for /L %%i in (1,1,30) do (
  powershell -NoLogo -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:1455 -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto dashboard_ready
  timeout /t 1 /nobreak >nul
)
echo The local server did not become ready. Check its output above and restart this file.
pause
exit /b 1

:dashboard_ready
start "" http://127.0.0.1:1455
echo AI Developer Bridge is running. Keep this window open; press Ctrl+C to stop the local server.
pause >nul
