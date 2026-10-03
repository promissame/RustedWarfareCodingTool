@echo off
setlocal enabledelayedexpansion
title 铁锈代码编写器 · 打包安卓 APK
cd /d "%~dp0"

echo ============================================================
echo   铁锈代码编写器 —— 打包安卓 App（APK）
echo ============================================================
echo.
echo 说明：这个工具要读写你电脑上的模组文件，所以安卓端是一个
echo       「壳」：装到手机上后，连到你电脑上跑的服务（局域网模式）。
echo       打包前请先用「启动-局域网.bat」确认手机能打开界面。
echo.

rem 需要 python（本项目自带，用来写 UTF-8 配置文件）
where python >nul 2>nul
if errorlevel 1 (
  echo [X] 没检测到 python。请先安装 Python 3.8+，或在项目目录里运行本脚本。
  pause ^& exit /b 1
)

rem ============================================================
rem  1. Node.js（Capacitor 7 需要 Node 20+）
rem ============================================================
where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没检测到 Node.js。请先安装 Node.js 20+：https://nodejs.org/
  pause & exit /b 1
)
set "NODEVER="
for /f "tokens=1 delims=." %%v in ('node --version') do set "NODEVER=%%v"
set "NODEVER=%NODEVER:v=%"
echo [OK] Node.js v%NODEVER%
if %NODEVER% LSS 20 (
  echo [!] Node 版本偏低，Capacitor 7 需要 Node 20+，请升级后再打包。
  pause & exit /b 1
)

rem ============================================================
rem  2. Android SDK
rem ============================================================
set "SDK="
if defined ANDROID_HOME set "SDK=%ANDROID_HOME%"
if not defined SDK if defined ANDROID_SDK_ROOT set "SDK=%ANDROID_SDK_ROOT%"
if not defined SDK if exist "%LOCALAPPDATA%\Android\Sdk" set "SDK=%LOCALAPPDATA%\Android\Sdk"
if not defined SDK (
  echo [X] 没找到 Android SDK。两种装法：
  echo     - 装 Android Studio（推荐）：https://developer.android.com/studio
  echo       安装向导里勾 Android SDK Platform-Tools / Build-Tools / Platform
  echo     - 只装命令行工具：下载 Command line tools only，解压到
  echo       LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\ 然后运行
  echo       sdkmanager "platform-tools" "build-tools;36.0.0" "platforms;android-35"
  pause & exit /b 1
)
echo [OK] Android SDK: %SDK%

rem ============================================================
rem  3. JDK：Android 的 Gradle 8.x 只支持到 JDK 23，
rem     Android Studio 自带的往往太新（24+），所以要找 17/21
rem ============================================================
set "JDK="
for /d %%p in (
  "%LOCALAPPDATA%\Android\jdk-21"
  "%LOCALAPPDATA%\Android\jdk-17"
  "%ProgramFiles%\Eclipse Adoptium\jdk-21*"
  "%ProgramFiles%\Eclipse Adoptium\jdk-17*"
  "%ProgramFiles%\Microsoft\jdk-21*"
  "%ProgramFiles%\Microsoft\jdk-17*"
  "%ProgramFiles%\Java\jdk-21*"
  "%ProgramFiles%\Java\jdk-17*"
) do (
  if not defined JDK if exist "%%~p\bin\java.exe" set "JDK=%%~p"
)
if not defined JDK if defined JAVA_HOME (
  if exist "%JAVA_HOME%\bin\java.exe" (
    set "BADVER=0"
    "%JAVA_HOME%\bin\java.exe" -version 2>&1 | findstr /r "version.*[ ]1[.]" >nul && set "BADVER=1"
    "%JAVA_HOME%\bin\java.exe" -version 2>&1 | findstr /r "version.*[ ]1[0-6][.]" >nul && set "BADVER=1"
    "%JAVA_HOME%\bin\java.exe" -version 2>&1 | findstr /r "version.*2[4-9][.]" >nul && set "BADVER=1"
    if "!BADVER!"=="0" set "JDK=%JAVA_HOME%"
  )
)
if not defined JDK (
  echo.
  echo [注意] 没找到能用的 JDK 17-23（Android Studio 自带的通常太新，Gradle 8 用不了）。
  choice /c YN /m "要我现在自动下载一个 JDK 21 吗（约 200 MB，只下一次）"
  if errorlevel 2 (
    echo 已取消。你也可以自己装 JDK 21（https://adoptium.net/）后重跑本脚本。
    pause & exit /b 1
  )
  echo [*] 下载 Temurin JDK 21 ...
  curl -L --fail -o "%TEMP%\rtcoder-jdk21.zip" "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse"
  if errorlevel 1 ( echo [X] 下载失败，检查网络后重试 & pause & exit /b 1 )
  echo [*] 解压到 %LOCALAPPDATA%\Android\jdk-21 ...
  powershell -NoProfile -Command "Expand-Archive -Force '%TEMP%\rtcoder-jdk21.zip' '%TEMP%\rtcoder-jdk21'"
  for /d %%d in ("%TEMP%\rtcoder-jdk21\jdk-21*") do move "%%d" "%LOCALAPPDATA%\Android\jdk-21" >nul
  del "%TEMP%\rtcoder-jdk21.zip" >nul 2>nul
  rd /s /q "%TEMP%\rtcoder-jdk21" >nul 2>nul
  if exist "%LOCALAPPDATA%\Android\jdk-21\bin\java.exe" (
    set "JDK=%LOCALAPPDATA%\Android\jdk-21"
  ) else (
    echo [X] JDK 21 安装失败，请手动安装后重试 & pause & exit /b 1
  )
)
set "JAVA_HOME=%JDK%"
echo [OK] JDK: %JDK%
"%JDK%\bin\java.exe" -version 2>&1 | findstr /i version

rem ============================================================
rem  4. 电脑的局域网地址（App 要连它）
rem ============================================================
set "ADDR="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  if not defined ADDR (
    set "LINE=%%a"
    for /f "tokens=* delims= " %%b in ("!LINE!") do set "ADDR=%%b"
  )
)
if not defined ADDR set "ADDR=192.168.1.100"
echo.
echo 你电脑在局域网里的地址大概是：%ADDR%（端口默认 8760）
set /p ADDRIN=直接回车用这个，或输入 地址:端口 ：
if not "%ADDRIN%"=="" set "ADDR=%ADDRIN%"
echo [*] App 将连接 http://%ADDR%/（记得先在电脑上开「启动-局域网.bat」）
echo.

rem ============================================================
rem  5. 在纯英文路径下建工程并编译
rem     Android 的构建工具不支持中文/非 ASCII 路径，所以放这儿
rem ============================================================
set "WORK=%LOCALAPPDATA%\RTCoderAndroid"
echo [*] 构建目录：%WORK%
if not exist "%WORK%" mkdir "%WORK%"
pushd "%WORK%"

if not exist "package.json" (
  echo [*] 初始化工程（第一次会联网下载依赖）...
  call npm init -y >nul
  call npm install @capacitor/core@7 @capacitor/cli@7 @capacitor/android@7
  if errorlevel 1 ( echo [X] npm 安装失败，检查网络后重试 & popd & pause & exit /b 1 )
)

echo [*] 写入 Capacitor 配置（交给 python 写，保证 UTF-8 不乱码）...
python "%~dp0android_config.py" "%WORK%" "%ADDR%"
if errorlevel 1 ( echo [X] 写配置失败，检查上面的报错 ^(需要 python^) & popd & pause & exit /b 1 )

if not exist "android" (
  echo [*] 添加 Android 平台 ...
  call npx cap add android
  if errorlevel 1 ( echo [X] cap add android 失败 & popd & pause & exit /b 1 )
)

echo [*] 同步工程 ...
call npx cap sync android
if errorlevel 1 ( echo [X] cap sync 失败 & popd & pause & exit /b 1 )

rem SDK 位置用正斜杠最稳（properties 里的反斜杠会被当转义符吃掉）
> android\local.properties echo sdk.dir=%SDK:\=/%

rem 让 Gradle 用我们选好的 JDK（AS 自带的 24+ 用不了）
findstr /b /c:"org.gradle.java.home" android\gradle.properties >nul 2>nul
if errorlevel 1 >> android\gradle.properties echo org.gradle.java.home=%JDK:\=/%

echo [*] 开始编译 Debug APK（第一次要下载 Gradle 依赖，几分钟）...
pushd android
call gradlew.bat assembleDebug
if errorlevel 1 (
  echo.
  echo [X] 编译失败。常见原因：
  echo     - JDK 版本问题：删掉 %WORK%\android\gradle.properties 里的
  echo       org.gradle.java.home 那行，装个 JDK 21 后重跑
  echo     - 首次编译需要联网下载 Gradle 和依赖
  echo     - 缺 Android 平台版本：报错里会写明需要 platforms;android-XX
  popd & popd & pause & exit /b 1
)
popd

set "APK="
for /f "delims=" %%f in ('dir /b /s android\app\build\outputs\apk\debug\*.apk 2^>nul') do set "APK=%%f"
popd
if not defined APK ( echo [X] 没找到生成的 APK & pause & exit /b 1 )

if not exist "dist" mkdir "dist"
copy /y "%APK%" "dist\铁锈代码编写器.apk" >nul

echo.
echo ============================================================
echo   打包完成：dist\铁锈代码编写器.apk
echo   传到手机安装（需要允许"安装未知来源应用"）。
echo   用之前先在电脑上运行「启动-局域网.bat」让服务跑起来。
echo   想换连接地址：改 %WORK%\capacitor.config.json 里的 server.url，
echo   或直接删掉 %WORK% 目录后重跑本脚本。
echo ============================================================
pause
