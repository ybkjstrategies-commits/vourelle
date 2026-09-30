@echo off
rem One-time: opens the official DSers login page. Your password goes to DSers only.
cd /d "%~dp0"
node node_modules\@lofder\dsers-mcp-product\dist\cli.js login
pause
