@echo off
chcp 65001 >nul
title Steam 好友收割机 · 更新器
rem 优先用 pythonw 启动可视化更新器（无黑框）；找不到再退回控制台模式
where pythonw >nul 2>nul
if %errorlevel%==0 (
  start "" pythonw "%~dp0_auto_update.py"
  exit /b 0
)
python "%~dp0_auto_update.py" --cli
echo.
pause
