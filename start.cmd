@echo off
rem Double-click to start the app and open it in your browser, with a window.
rem For starting it with Windows and without a window, see deploy\windows\install-autostart.cmd.
cd /d "%~dp0"
rem Take the newest version from GitHub first; carry on with this one if that fails.
git pull --ff-only -q 2>nul && call npm install --no-audit --no-fund >nul 2>nul
if not exist node_modules (
  echo Installing, this takes a minute the first time...
  call npm install
)
set "OPEN=--open"
:run
node server\index.js %OPEN%
rem 75: the app took a new version from GitHub and wants to be started again.
if "%errorlevel%"=="75" ( set "OPEN=" & goto run )
pause
