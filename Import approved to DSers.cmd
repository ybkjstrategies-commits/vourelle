@echo off
rem Sends every row you marked "approve" to the DSers Import List. Save and close Excel first.
rem To import from an older workbook, drag it onto this file.
cd /d "%~dp0"
git pull -q --rebase --autostash
node src\import.js %1
git add state\decisions.json
git commit -q -m "Import decisions" && git push -q
pause
