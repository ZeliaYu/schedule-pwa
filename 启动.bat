@echo off
REM ===================================================================
REM  排班管理 PWA — 启动脚本（conda NAFNet 环境）
REM  双击运行后在浏览器打开 http://localhost:8765
REM ===================================================================
setlocal
cd /d "%~dp0"

set PYTHON=D:\Anaconda3\envs\NAFNet\python.exe
if not exist "%PYTHON%" (
    echo [错误] 未找到 NAFNet 环境的 Python: %PYTHON%
    echo 请修改本脚本中的 PYTHON 变量。
    pause
    exit /b 1
)

set SCHEDULE_HOST=0.0.0.0
set SCHEDULE_PORT=8765

echo.
echo  排班管理 PWA
echo  --------------------------------------
echo   本机访问:  http://localhost:%SCHEDULE_PORT%
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do echo   局域网访问: http://%%b:%SCHEDULE_PORT%
)
echo  --------------------------------------
echo   按 Ctrl+C 停止服务
echo.

start "" http://localhost:%SCHEDULE_PORT%
"%PYTHON%" backend\app.py
pause
