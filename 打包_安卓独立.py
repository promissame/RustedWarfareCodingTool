# -*- coding: utf-8 -*-
"""构建真正独立的 Android APK：Chaquopy + Flask + WebView。"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / 'android_standalone'
DIST = ROOT / 'dist'


def die(msg):
    print('[X] ' + msg)
    sys.exit(1)


def find_sdk():
    for key in ('ANDROID_HOME', 'ANDROID_SDK_ROOT'):
        p = os.environ.get(key)
        if p and Path(p).is_dir():
            return Path(p)
    p = Path(os.environ.get('LOCALAPPDATA', '')) / 'Android/Sdk'
    return p if p.is_dir() else None


def find_jdk():
    candidates = [
        Path(os.environ.get('LOCALAPPDATA', '')) / 'Android/jdk-21',
        Path(os.environ.get('LOCALAPPDATA', '')) / 'Android/jdk-17',
        Path('C:/Program Files/Eclipse Adoptium'),
        Path('C:/Program Files/Java'),
    ]
    # 优先 Android 专用 JDK；全局 JAVA_HOME 可能是 1.8，不能用于 AGP 8
    for p in candidates:
        if p.is_dir() and (p / 'bin/java.exe').is_file():
            return p
        if p.is_dir():
            for sub in sorted(p.iterdir(), reverse=True):
                if (sub / 'bin/java.exe').is_file():
                    return sub
    java_home = os.environ.get('JAVA_HOME')
    if java_home and (Path(java_home) / 'bin/java.exe').is_file():
        return Path(java_home)
    return None


def main():
    sdk = find_sdk()
    if not sdk:
        die('没找到 Android SDK。请设置 ANDROID_HOME 或安装 Android Studio。')
    jdk = find_jdk()
    if not jdk:
        die('没找到 JDK 17+。请安装 Temurin JDK 21，或设置 JAVA_HOME。')
    py = Path(sys.executable)
    if not py.is_file():
        die('找不到构建用 Python。')
    pv = sys.version_info[:2]
    if not ((3, 10) <= pv <= (3, 15)):
        die('构建用 Python 需要 3.10–3.15，当前是 %d.%d。' % pv)
    print('[OK] SDK:', sdk)
    print('[OK] JDK:', jdk)
    print('[OK] Python:', py)

    work = Path(os.environ.get('LOCALAPPDATA', '')) / 'RTCoderAndroidStandalone'
    work.mkdir(parents=True, exist_ok=True)
    # 保留 app/build/python 的 pip 环境，后续构建不用重新下载 Flask
    shutil.copytree(TEMPLATE, work, dirs_exist_ok=True)
    app = work / 'app'
    py_src = app / 'src/main/python'
    assets = app / 'src/main/assets/rtcoder'
    (assets / 'static').mkdir(parents=True, exist_ok=True)
    (assets / 'data').mkdir(parents=True, exist_ok=True)
    (assets / 'static').parent.mkdir(parents=True, exist_ok=True)

    # Python：当前 server.py + Android 启动器
    shutil.copy2(ROOT / 'server.py', py_src / 'server.py')
    shutil.copy2(TEMPLATE / 'app/src/main/python/rt_server.py', py_src / 'rt_server.py')

    # 静态资源与默认数据
    if (assets / 'static').exists():
        shutil.rmtree(assets / 'static')
    shutil.copytree(ROOT / 'static', assets / 'static')
    for name in ('code_table.json', 'backpack.json'):
        src = ROOT / 'data' / name
        if src.is_file():
            shutil.copy2(src, assets / 'data' / name)

    # 图标
    icon_src = ROOT / 'static/icons/icon-192.png'
    icon_dst = app / 'src/main/res/drawable/ic_launcher.png'
    icon_dst.parent.mkdir(parents=True, exist_ok=True)
    if icon_src.is_file():
        shutil.copy2(icon_src, icon_dst)

    # build.gradle 注入 Python 路径
    bg = app / 'build.gradle'
    text = bg.read_text(encoding='utf-8').replace('__BUILD_PYTHON__', str(py).replace('\\', '/'))
    text = text.replace("version '3.12'", "version '%d.%d'" % pv)
    bg.write_text(text, encoding='utf-8')

    # Gradle wrapper：模板自带；旧模板缺失时回退到 Capacitor 工程
    if not (work / 'gradlew.bat').is_file():
        cap = Path(os.environ.get('LOCALAPPDATA', '')) / 'RTCoderAndroid/android'
        for name in ('gradle', 'gradlew', 'gradlew.bat'):
            src = cap / name
            if src.exists():
                dst = work / name
                if src.is_dir():
                    shutil.copytree(src, dst, dirs_exist_ok=True)
                else:
                    shutil.copy2(src, dst)
    if not (work / 'gradlew.bat').is_file():
        die('缺少 gradlew。')

    (work / 'local.properties').write_text('sdk.dir=' + str(sdk).replace('\\', '/') + '\n', encoding='utf-8')
    gp = work / 'gradle.properties'
    gp.write_text((gp.read_text(encoding='utf-8') if gp.exists() else '')
                  + '\norg.gradle.java.home=' + str(jdk).replace('\\', '/') + '\n', encoding='utf-8')

    env = dict(os.environ)
    env['JAVA_HOME'] = str(jdk)
    env['ANDROID_HOME'] = str(sdk)
    env['ANDROID_SDK_ROOT'] = str(sdk)
    print('[..] 开始 Gradle 构建（首次会下载 Chaquopy/Python，可能较久）')
    r = subprocess.run([str(work / 'gradlew.bat'), 'assembleDebug', '--no-daemon'],
                       cwd=str(work), env=env)
    if r.returncode != 0:
        die('Gradle 构建失败，退出码 %s' % r.returncode)

    apks = list((app / 'build/outputs/apk/debug').glob('*.apk'))
    if not apks:
        die('构建结束但没找到 APK')
    DIST.mkdir(exist_ok=True)
    out = DIST / '铁锈代码编写器-独立版.apk'
    shutil.copy2(apks[0], out)
    print('[OK] APK:', out)
    print('安装后无需电脑，应用会在本机启动 Flask 服务。')


if __name__ == '__main__':
    main()
