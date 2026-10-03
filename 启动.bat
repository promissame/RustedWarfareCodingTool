@echo off
title 铁锈代码编写器 · 诺瓦御科 v1.15
cd /d "%~dp0"

echo ============================================================
echo   铁锈代码编写器  ——  诺瓦御科 v1.15 代码表图形化工具
echo ============================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [X] 没有检测到 Python，请先安装 Python 3.8+ 并勾选 Add to PATH
  pause & exit /b
)

python -c "import flask" >nul 2>nul
if errorlevel 1 (
  echo [*] 首次运行，正在安装依赖 flask ...
  python -m pip install flask -q
)

python -c "import openpyxl" >nul 2>nul
if errorlevel 1 (
  echo [*] 正在安装依赖 openpyxl ...
  python -m pip install openpyxl -q
)

if not exist "data\code_table.json" (
  echo [*] 正在从 xlsx 代码表生成数据 ...
  python build_data.py
  echo.
)

echo [*] 启动服务，浏览器会自动打开 http://127.0.0.1:8760
echo     代码表放在 代码表\ 目录里（换版本替换后重跑本脚本即可）
echo     关闭这个黑窗口即可退出。
echo.
python server.py
pause
