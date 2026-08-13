@echo off
chcp 65001 >nul
setlocal

rem Double-click launcher for the event.
rem
rem Opening a terminal and cd-ing to the right folder is where most of the
rem mistakes happen, so this removes that step entirely. Paths are resolved
rem relative to this file, so the folder can be moved and it still works.
rem
rem Everything here is ASCII on purpose: cmd.exe parses a batch file with the
rem console code page, and non-ASCII bytes in the script itself corrupt the
rem lines around them. All Korean output comes from Node, which handles UTF-8.

set "ROOT=%~dp0.."
cd /d "%ROOT%"
if errorlevel 1 (
  echo [ERROR] Could not enter the project folder:
  echo         %ROOT%
  pause
  exit /b 1
)

rem Your own playlist.txt wins; the bundled example is the fallback.
set "PLAYLIST=%ROOT%\playlist.txt"
if not exist "%PLAYLIST%" set "PLAYLIST=%ROOT%\data\playlist.example.txt"

echo.
echo ============================================
echo   Drop the Beat
echo ============================================
echo.
echo Playlist: %PLAYLIST%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo         Install the LTS build from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

node scripts\host.ts --playlist "%PLAYLIST%" --songs "%ROOT%\data\songs.recovered.json"

rem Without this the window closes instantly on failure and the message is lost.
echo.
echo Server stopped.
pause
endlocal
