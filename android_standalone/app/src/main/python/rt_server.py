# -*- coding: utf-8 -*-
"""Android 独立版的 Python 启动器。"""
import os
import threading

_started = False


def start(res_dir, data_dir, output_dir, mod_root, port=8760):
    global _started
    if _started:
        return
    _started = True

    os.environ['RT_RES_DIR'] = res_dir
    os.environ['RT_APP_DIR'] = res_dir
    os.environ['RT_DATA_DIR'] = data_dir
    os.environ['RT_OUTPUT_DIR'] = output_dir
    os.environ['RT_PORT'] = str(port)
    os.environ['RT_NO_BROWSER'] = '1'
    if mod_root and os.path.isdir(mod_root):
        os.environ['RT_MOD_ROOT'] = mod_root

    import server
    t = threading.Thread(
        target=server.start_server,
        args=('127.0.0.1', port),
        daemon=True,
        name='rtcoder-flask',
    )
    t.start()
