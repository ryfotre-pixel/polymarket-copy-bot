@echo off
rem Starts the LIVE bot: real orders with real money, using the settings in .env.
rem Leave this window open (minimizing is fine). Press Ctrl+C in it to stop the bot.
cd /d "%~dp0"
title Copy Bot - LIVE (real money)
call npm start
echo.
echo The live bot has stopped. Close this window, or double-click start-live-bot.bat to start it again.
pause
