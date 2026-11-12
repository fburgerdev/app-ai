@echo off
rem Starts the app without a window. Run by "Brain app.vbs" in the Startup folder
rem (see install-autostart.cmd). What it prints goes to startup.txt in the data folder.
cd /d "%~dp0..\.."
if not exist "%LOCALAPPDATA%\app-ai" mkdir "%LOCALAPPDATA%\app-ai"
set "OUT=%LOCALAPPDATA%\app-ai\startup.txt"
echo %date% %time% starting > "%OUT%"
git pull --ff-only -q >> "%OUT%" 2>&1
call npm install --no-audit --no-fund >> "%OUT%" 2>&1
node server\index.js >> "%OUT%" 2>&1
