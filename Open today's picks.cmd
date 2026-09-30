@echo off
rem Gets the newest workbook from the cloud run and opens your working copy in "My picks".
cd /d "%~dp0"
git pull -q --rebase --autostash
if not exist "My picks" mkdir "My picks"
for /f "delims=" %%f in ('dir /b /o:n output\vourelle_candidates_*.xlsx') do set LATEST=%%f
if not defined LATEST (echo No workbook yet. & pause & exit /b)
if not exist "My picks\%LATEST%" copy "output\%LATEST%" "My picks\%LATEST%" >nul
start "" "My picks\%LATEST%"
