# -*- coding: utf-8 -*-
"""
打包 Windows 单文件 exe（用 PyInstaller）

用法：
    python 打包_win.py            # 生成 dist\铁锈代码编写器.exe
    python 打包_win.py --console   # 保留控制台窗口（方便看日志/局域网地址）

说明：
    exe 会把 data/code_table.json、static/ 一起打进包里，
    运行时自动解出到临时目录，用户只需要双击 exe 就能用（不需要装 Python）。
    代码表 xlsx 也一起打包，首次运行若没有 code_table.json 会自动生成。
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = '铁锈代码编写器'


def ensure(pip_name, imp_name=None):
    try:
        __import__(imp_name or pip_name)
        return True
    except ImportError:
        print(f'[*] 安装打包依赖 {pip_name} ...')
        r = subprocess.run([sys.executable, '-m', 'pip', 'install', pip_name, '-q'])
        return r.returncode == 0


def make_spec(console=False):
    data = [
        ('static', 'static'),
        ('data/code_table.json', 'data'),
    ]
    xlsx = None
    for d in (os.path.join(HERE, '代码表'), HERE):
        if os.path.isdir(d):
            for f in os.listdir(d):
                if f.lower().endswith(('.xlsx', '.xlsm')):
                    xlsx = os.path.join(d, f)
                    break
        if xlsx:
            break
    if xlsx:
        data.append((xlsx, '代码表'))
    datas = ',\n        '.join('(%r, %r)' % (a, b) for a, b in data)
    spec = f"""# -*- mode: python ; coding: utf-8 -*-
# 由 打包_win.py 自动生成
a = Analysis(
    ['server.py'],
    pathex=[%r],
    binaries=[],
    datas=[
        {datas},
    ],
    hiddenimports=['flask', 'openpyxl', 'openpyxl.styles'],
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'numpy', 'pandas', 'PyQt5', 'PySide6'],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name=%r,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    runtime_tmpdir=None,
    console={console},
    icon=%r if os.path.exists(%r) else None,
)
""" % (HERE, NAME, os.path.join(HERE, 'static', 'icons', 'app.ico'),
       os.path.join(HERE, 'static', 'icons', 'app.ico'))
    return spec


def make_ico():
    """把 png 图标转成 ico（exe 图标）"""
    try:
        from PIL import Image
    except ImportError:
        return None
    src = os.path.join(HERE, 'static', 'icons', 'icon-512.png')
    dst = os.path.join(HERE, 'static', 'icons', 'app.ico')
    if not os.path.isfile(src):
        return None
    img = Image.open(src)
    img.save(dst, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    return dst


def main():
    console = '--console' in sys.argv
    if not ensure('pyinstaller', 'PyInstaller'):
        sys.exit('[X] PyInstaller 安装失败，请手动执行：pip install pyinstaller')
    if not os.path.isfile(os.path.join(HERE, 'data', 'code_table.json')):
        print('[*] 先生成代码表数据 ...')
        subprocess.run([sys.executable, 'build_data.py'], cwd=HERE, check=False)

    ico = make_ico()
    if ico:
        print('[*] exe 图标：', ico)
    spec_path = os.path.join(HERE, '%s.spec' % NAME)
    with open(spec_path, 'w', encoding='utf-8') as f:
        f.write(make_spec(console))

    print('[*] 开始打包（第一次大约 1-2 分钟）...')
    r = subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', spec_path],
                       cwd=HERE)
    if r.returncode != 0:
        sys.exit('[X] 打包失败，看上面的错误信息')

    exe = os.path.join(HERE, 'dist', NAME + '.exe')
    # 把说明和代码表也放到 dist，方便整个文件夹拷走
    for extra in ('README.md', '启动.bat', '启动-局域网.bat'):
        src = os.path.join(HERE, extra)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(HERE, 'dist', extra))
    if os.path.isdir(os.path.join(HERE, '代码表')):
        shutil.copytree(os.path.join(HERE, '代码表'), os.path.join(HERE, 'dist', '代码表'),
                        dirs_exist_ok=True)
    if os.path.isdir(os.path.join(HERE, 'data')):
        os.makedirs(os.path.join(HERE, 'dist', 'data'), exist_ok=True)
        for f in ('backpack.json',):
            src = os.path.join(HERE, 'data', f)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(HERE, 'dist', 'data', f))

    size = os.path.getsize(exe) / 1024 / 1024 if os.path.isfile(exe) else 0
    print('=' * 56)
    print(f'  打包完成：{exe}  ({size:.1f} MB)')
    print('  双击它就能启动编写器（会在浏览器里打开界面）')
    print('  dist 目录可以整个拷给别人，不需要装 Python')
    print('=' * 56)


if __name__ == '__main__':
    main()
