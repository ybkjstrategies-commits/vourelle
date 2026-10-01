@echo off
rem One-time: opens the official DSers login page. Your password goes to DSers only.
cd /d "%~dp0"
node src\dsers.js laptop-login
pause
