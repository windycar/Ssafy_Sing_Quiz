@echo off
chcp 65001 >nul
setlocal

rem Double-click launcher. This is the only file anyone needs to run.
rem
rem It prepares the three files a host edits - the song list, the proverbs and
rem the idioms - in this folder, then starts the game on a public address.
rem
rem Everything in this script is ASCII on purpose: cmd.exe parses a batch file
rem with the console code page, and non-ASCII bytes in the script itself
rem corrupt the lines around them. The Korean file names live in
rem server/localFiles.ts, where Node handles UTF-8 properly, and all Korean
rem output below comes from Node for the same reason.

cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] Could not enter the project folder:
  echo         %~dp0
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Drop the Beat
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo         Install the LTS build from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

rem Creates the editable files if they are missing. Never overwrites.
node scripts\prepare-files.ts
if errorlevel 1 (
  echo.
  echo [ERROR] Could not prepare the editable files.
  pause
  exit /b 1
)

rem No --playlist here on purpose: server/main.ts finds this folder's song list
rem itself, so which file wins is decided in one place instead of two.
node scripts\host.ts

rem Without this the window closes instantly on failure and the message is lost.
echo.
echo Server stopped.
pause
endlocal
