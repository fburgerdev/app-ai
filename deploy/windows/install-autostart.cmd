@echo off
rem Makes the app start by itself, without a window, every time you log in to Windows.
rem Run once (double-click). To undo: delete "Brain app.vbs" from the Startup folder
rem (Win+R, shell:startup).
for %%I in ("%~dp0..\..") do set "APP=%%~fI"
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Brain app.vbs"
> "%VBS%" echo Set sh = CreateObject("WScript.Shell")
>> "%VBS%" echo sh.CurrentDirectory = "%APP%"
>> "%VBS%" echo sh.Run "cmd /c git pull --ff-only -q ^& npm install --no-audit --no-fund ^>nul 2^>nul ^& node server\index.js", 0, False
wscript "%VBS%"
echo The app now starts with Windows, and is running: http://localhost:4317
pause
