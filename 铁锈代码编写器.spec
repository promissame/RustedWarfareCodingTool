# -*- mode: python ; coding: utf-8 -*-
# 由 打包_win.py 自动生成
a = Analysis(
    ['server.py'],
    pathex=['D:\\铁锈代码编写器'],
    binaries=[],
    datas=[
        ('static', 'static'),
        ('data/code_table.json', 'data'),
        ('D:\\铁锈代码编写器\\代码表\\诺瓦御科：v1.15代码表.xlsx', '代码表'),
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
    name='铁锈代码编写器',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    runtime_tmpdir=None,
    console=False,
    icon='D:\\铁锈代码编写器\\static\\icons\\app.ico' if os.path.exists('D:\\铁锈代码编写器\\static\\icons\\app.ico') else None,
)
