@echo off
REM ===================================================================
REM  排班管理 PWA — 本地预览（纯静态，无后端）
REM  也可以用 GitHub Pages 的在线地址，无需运行本脚本。
REM ===================================================================
setlocal
cd /d "%~dp0docs"

set PYTHON=D:\Anaconda3\envs\NAFNet\python.exe
if not exist "%PYTHON%" set PYTHON=python

set PORT=8765

echo.
echo  排班管理 PWA（本地预览）
echo  --------------------------------------
echo   本机访问:  http://localhost:%PORT%
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do echo   局域网访问: http://%%b:%PORT%
)
echo  --------------------------------------
echo   按 Ctrl+C 停止
echo.
echo   注意：手机通过局域网访问时，Service Worker 需要 https 或 localhost，
echo         用 IP 访问将无法离线安装；正式使用请用 GitHub Pages 地址。
echo.

start "" http://localhost:%PORT%
"%PYTHON%" -m http.server %PORT% --bind 0.0.0.0
pause
