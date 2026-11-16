@echo off
rem Starts the dashboard and the three DRY-RUN bots (no real money), each in its own minimized window.
rem Safe to double-click after a restart. Does NOT start the live bot: use start-live-bot.bat for that.
cd /d "%~dp0"
start "Copy Bot - dashboard" /min cmd /k npm run dashboard
start "Copy Bot - chongchong37 sized DRY" /min cmd /k npm run dry:sized
start "Copy Bot - 0x9674 DRY" /min cmd /k npm run dry:w9674
start "Copy Bot - 0x9674 sized DRY" /min cmd /k npm run dry:w9674-sized
