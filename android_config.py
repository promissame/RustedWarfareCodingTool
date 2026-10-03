# -*- coding: utf-8 -*-
"""
android_config.py —— 供「打包_安卓.bat」调用

批处理文件是 GBK 编码，用它写 JSON/HTML 会得到 GBK 字节，
而 Capacitor / Android 都按 UTF-8 读，中文就会变成乱码。
所以这些文件统一由这个脚本以 UTF-8 写出来。

用法：
    python android_config.py <构建目录> <地址:端口>
"""
import json
import os
import sys

APP_ID = 'com.rusted.rtcoder'
APP_NAME = '铁锈代码编写器'

LANDING = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>铁锈代码编写器</title>
</head>
<body style="margin:0;background:#0d1117;color:#9fb0c6;font-family:system-ui,'Microsoft YaHei UI',sans-serif">
  <p style="padding:24px;line-height:1.8">正在连接电脑上的编写器服务…<br>
  <span style="color:#6b7d94;font-size:13px">如果一直停在这里，请确认电脑上已运行「启动-局域网.bat」，并且手机和电脑在同一个 WiFi。</span></p>
</body>
</html>
'''


def main():
    if len(sys.argv) < 3:
        sys.exit('用法: python android_config.py <构建目录> <地址:端口>')
    work = sys.argv[1]
    addr = sys.argv[2].strip().rstrip('/')
    if not addr:
        sys.exit('地址不能为空')

    os.makedirs(work, exist_ok=True)
    cfg = {
        'appId': APP_ID,
        'appName': APP_NAME,
        'webDir': 'www',
        'server': {'url': 'http://%s/' % addr, 'cleartext': True},
        'android': {'allowMixedContent': True},
    }
    with open(os.path.join(work, 'capacitor.config.json'), 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

    www = os.path.join(work, 'www')
    os.makedirs(www, exist_ok=True)
    with open(os.path.join(www, 'index.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(LANDING)

    print('[OK] 已写入 capacitor.config.json（UTF-8）：%s -> http://%s/' % (APP_NAME, addr))


if __name__ == '__main__':
    main()
