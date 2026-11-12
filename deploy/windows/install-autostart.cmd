@echo off
rem Makes the app start by itself, without a window, every time you log in to Windows,
rem and starts it now. Run once (double-click). To undo: Win+R, shell:startup, delete
rem "Brain app.vbs". If the app does not come up, %LOCALAPPDATA%\app-ai\startup.txt says why.
set "RUN=%~dp0run.cmd"
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Brain app.vbs"
> "%VBS%" echo CreateObject("WScript.Shell").Run """%RUN%""", 0, False
wscript "%VBS%"
echo Starting the app. In a few seconds it is at http://localhost:4317
timeout /t 8 >nul
start "" http://localhost:4317
