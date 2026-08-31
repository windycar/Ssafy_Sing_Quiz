@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo.
echo ============================================
echo   Install cloudflared
echo ============================================
echo.

where.exe cloudflared >nul 2>nul
if not errorlevel 1 (
  echo cloudflared is already installed.
  cloudflared --version
  echo.
  echo You can run 게임시작.bat now.
  pause
  exit /b 0
)

where.exe winget >nul 2>nul
if errorlevel 1 (
  echo [ERROR] winget was not found.
  echo Install or update App Installer from the Microsoft Store,
  echo then run this file again.
  echo.
  pause
  exit /b 1
)

echo Installing cloudflared with winget...
echo If Windows asks for permission, allow the installation.
echo.
winget install --id Cloudflare.cloudflared --exact --source winget --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
  echo.
  echo [ERROR] cloudflared installation failed.
  echo Try running this file as administrator and run it again.
  echo.
  pause
  exit /b 1
)

echo.
echo Installation completed.
echo Close this window and open a new terminal before running 게임시작.bat.
echo The new terminal is needed for the updated PATH to take effect.
echo.
pause
endlocal
