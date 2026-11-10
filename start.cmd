@echo off
rem Double-click to start the inbox app and open it in your browser.
cd /d "%~dp0"
rem Take the newest version from GitHub first; carry on with this one if that fails.
git pull --ff-only -q 2>nul && call npm install --no-audit --no-fund >nul 2>nul
if not exist node_modules (
  echo Installing, this takes a minute the first time...
  call npm install
)
node server\index.js --open
pause
