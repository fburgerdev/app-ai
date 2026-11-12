@echo off
rem Starts the app without a window. Run by "Brain app.vbs" in the Startup folder
rem (see install-autostart.cmd). What it prints goes to startup.txt in the data folder.
rem The app updates itself while it runs: it exits with code 75 after taking a new
rem version, and this starts it again. If a new version does not start, this goes back
rem to the one before.
cd /d "%~dp0..\.."
set "DATA=%LOCALAPPDATA%\app-ai"
if not exist "%DATA%" mkdir "%DATA%"
set "OUT=%DATA%\startup.txt"
echo %date% %time% starting > "%OUT%"
git pull --ff-only -q >> "%OUT%" 2>&1
call npm install --no-audit --no-fund >> "%OUT%" 2>&1
:run
echo %date% %time% app starts >> "%OUT%"
node server\index.js >> "%OUT%" 2>&1
set "CODE=%errorlevel%"
if "%CODE%"=="75" goto run
if exist "%DATA%\update-prev.txt" (
  set /p PREV=<"%DATA%\update-prev.txt"
  git rev-parse HEAD > "%DATA%\update-bad.txt"
  del "%DATA%\update-prev.txt"
  echo %date% %time% the new version did not start; going back >> "%OUT%"
  call git reset --hard -q %%PREV%% >> "%OUT%" 2>&1
  call npm install --no-audit --no-fund >> "%OUT%" 2>&1
  goto run
)
echo %date% %time% app stopped with code %CODE% >> "%OUT%"
