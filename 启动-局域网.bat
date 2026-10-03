@echo off
title 铁锈代码编写器 · 局域网模式（手机也能用）
cd /d "%~dp0"

echo ============================================================
echo   铁锈代码编写器 —— 局域网模式
echo   手机/平板连同一个 WiFi，用浏览器访问下面显示的地址
echo ============================================================
echo.

if exist "铁锈代码编写器.exe" (
  echo [*] 使用打包好的 exe 启动 ...
  "铁锈代码编写器.exe" --lan
  goto :eof
)

where python >nul 2>nul
if errorlevel 1 (
  echo [X] 没检测到 Python。请用 exe 版本，或先安装 Python 3.8+
  pause & exit /b
)
python -c "import flask" >nul 2>nul || python -m pip install flask -q
python -c "import openpyxl" >nul 2>nul || python -m pip install openpyxl -q
if not exist "data\code_table.json" python build_data.py
python server.py --lan
pause
