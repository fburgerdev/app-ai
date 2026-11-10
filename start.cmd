@echo off
rem Double-click to start the inbox app and open it in your browser.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing, this takes a minute the first time...
  call npm install
)
node server\index.js --open
pause
