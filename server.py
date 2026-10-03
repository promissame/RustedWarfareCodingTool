
# -*- coding: utf-8 -*-
"""
server.py —— 铁锈代码编写器 本地服务

启动后浏览器访问 http://127.0.0.1:8760
"""
import json
import os
import re
import sys
import time
import webbrowser
import threading

try:
    from flask import Flask, jsonify, request, send_from_directory, abort
except ImportError:
    sys.exit('缺少 flask，请先执行：pip install flask')

FROZEN = bool(getattr(sys, 'frozen', False))
if FROZEN:
    # 打包成 exe 后：static / code_table.json 在临时解包目录里，用户数据放在 exe 旁边
    RES = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(sys.executable)))
    APP_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    RES = os.path.dirname(os.path.abspath(__file__))
    APP_DIR = RES

HERE = RES
STATIC = os.path.join(RES, 'static')


def _writable(d):
    try:
        os.makedirs(d, exist_ok=True)
        probe = os.path.join(d, '.w')
        with open(probe, 'w') as f:
            f.write('1')
        os.remove(probe)
        return True
    except OSError:
        return False


# 可写数据目录：优先 exe 同级的 data\（整个文件夹可以拷走），不可写就退回 %APPDATA%
DATA = os.path.join(APP_DIR, 'data')
if not _writable(DATA):
    DATA = os.path.join(os.environ.get('APPDATA') or APP_DIR, '铁锈代码编写器', 'data')
    _writable(DATA)
CONFIG = os.path.join(DATA, 'config.json')
BACKPACK = os.path.join(DATA, 'backpack.json')
PORT = int(os.environ.get('RT_PORT', '8760'))
LAN = os.environ.get('RT_LAN') == '1'          # 局域网模式：手机/平板也能连


def local_ips():
    """本机在局域网里的 IPv4（给手机连）：滤掉虚拟网卡/自动私有地址，按常用网段排序"""
    import socket
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.4)
        s.connect(('8.8.8.8', 80))             # 不会真的发包，只用来选默认网卡
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass

    def score(ip):
        if ip.startswith('192.168.'):
            return 0
        if ip.startswith('10.'):
            return 1
        if ip.startswith('172.'):
            try:
                if 16 <= int(ip.split('.')[1]) <= 31:
                    return 2
            except ValueError:
                pass
        if ip.startswith('169.254.') or ip.startswith('127.'):
            return 9                            # APIPA / 本机，基本不是要用的那个
        return 5

    good = [ip for ip in ips if score(ip) < 9]
    good.sort(key=score)
    return good


def load_config():
    try:
        with open(CONFIG, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    os.makedirs(DATA, exist_ok=True)
    with open(CONFIG, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)


def default_root():
    """模组根目录：优先用上次记住的；打包成 exe 时默认就是 exe 所在目录"""
    cfg = load_config()
    root = os.environ.get('RT_MOD_ROOT') or cfg.get('modRoot')
    if root and os.path.isdir(root):
        return os.path.abspath(root)
    if FROZEN:
        return os.path.abspath(APP_DIR)
    parent = os.path.dirname(HERE)
    return os.path.abspath(parent if os.path.isdir(parent) else HERE)

app = Flask(__name__, static_folder=None)
RE_VER = __import__('re').compile(r'\{\{V\}\}')


@app.after_request
def allow_cross_origin(resp):
    """允许被"包装成 App"的移动端（Capacitor / WebView，来源不同）调用接口"""
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return resp


@app.route('/api/<path:_any>', methods=['OPTIONS'])
def api_preflight(_any):
    return ('', 204)

_META_CACHE = {}


def meta_path():
    """代码表数据：优先用户目录（可能被重新生成过），否则用打包进来的那份"""
    p = os.path.join(DATA, 'code_table.json')
    if os.path.isfile(p):
        return p
    p2 = os.path.join(RES, 'data', 'code_table.json')
    return p2 if os.path.isfile(p2) else p


def load_meta():
    p = meta_path()
    if not os.path.isfile(p):
        return None
    mtime = os.path.getmtime(p)
    if _META_CACHE.get('mtime') != mtime:
        with open(p, encoding='utf-8') as f:
            _META_CACHE['data'] = json.load(f)
        _META_CACHE['mtime'] = mtime
    return _META_CACHE['data']


def read_text(path):
    for enc in ('utf-8-sig', 'utf-8', 'gbk', 'latin-1'):
        try:
            with open(path, encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read()


# ---------------------------------------------------------------- 页面

@app.route('/')
def index():
    """首页：给静态资源带上 mtime 版本号，改了 js/css 之后浏览器不会用旧缓存"""
    with open(os.path.join(STATIC, 'index.html'), encoding='utf-8') as f:
        html = f.read()
    ver = 0
    for name in ('app.js', 'style.css'):
        p = os.path.join(STATIC, name)
        if os.path.isfile(p):
            ver = max(ver, int(os.path.getmtime(p)))
    return RE_VER.sub(str(ver), html)


@app.route('/static/<path:name>')
def static_file(name):
    return send_from_directory(STATIC, name)


@app.route('/favicon.ico')
def favicon():
    p = os.path.join(STATIC, 'favicon.ico')
    if os.path.isfile(p):
        return send_from_directory(STATIC, 'favicon.ico')
    abort(404)


# ---------------------------------------------------------------- API

@app.route('/api/meta')
def api_meta():
    m = load_meta()
    if m is None:
        return jsonify({'error': '缺少代码表数据，请先运行 build_data.py 生成 data/code_table.json'}), 500
    return jsonify(m)


@app.route('/api/meta/source')
def api_meta_source():
    """返回代码表源文件绝对路径（下载/查看用）"""
    m = load_meta() or {}
    src = m.get('source', '')
    for d in (os.path.dirname(HERE), HERE):
        p = os.path.join(d, src)
        if os.path.isfile(p):
            return jsonify({'path': p, 'exists': True})
    return jsonify({'path': os.path.join(os.path.dirname(HERE), src), 'exists': False})


@app.route('/api/config', methods=['GET', 'POST'])
def api_config():
    """记住模组根目录（界面里选过之后就存在 data/config.json）"""
    cfg = load_config()
    if request.method == 'POST':
        d = request.get_json(force=True, silent=True) or {}
        root = (d.get('modRoot') or '').strip()
        if root and os.path.isdir(root):
            cfg['modRoot'] = os.path.abspath(root)
            save_config(cfg)
        return jsonify({'ok': True, 'modRoot': cfg.get('modRoot') or default_root()})
    return jsonify({'modRoot': default_root(), 'project': HERE})


@app.route('/api/browse')
def api_browse():
    """列出某个目录下的子目录与 ini 文件（用于打开模组里的单位）"""
    path = request.args.get('path') or default_root()
    path = os.path.abspath(path)
    if not os.path.isdir(path):
        return jsonify({'error': '目录不存在: ' + path}), 400

    def valid(p):
        return not p.startswith('.') and '_dump' not in p

    dirs, files = [], []
    try:
        for name in sorted(os.listdir(path)):
            full = os.path.join(path, name)
            if not valid(name):
                continue
            if os.path.isdir(full):
                dirs.append({'name': name, 'path': full})
            elif name.lower().endswith(('.ini', '.template', '.md')):
                files.append({'name': name, 'path': full,
                              'size': os.path.getsize(full)})
    except PermissionError:
        return jsonify({'error': '无权限访问: ' + path}), 403
    return jsonify({'path': path, 'parent': os.path.dirname(path),
                    'dirs': dirs, 'files': files})


@app.route('/api/file/load')
def api_file_load():
    path = request.args.get('path', '')
    if not path or not os.path.isfile(path):
        return jsonify({'error': '文件不存在'}), 404
    return jsonify({'path': path, 'name': os.path.basename(path),
                    'text': read_text(path)})


# ================================================================ 资源管理器
IMAGE_EXT = ('.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp')
AUDIO_EXT = ('.ogg', '.wav', '.mp3', '.m4a')
MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp',
        '.gif': 'image/gif', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4'}
TRASH_PREFIX = '_回收站_'


def file_kind(name):
    e = os.path.splitext(name)[1].lower()
    if e in IMAGE_EXT:
        return 'image'
    if e in AUDIO_EXT:
        return 'audio'
    if e in ('.ini', '.template'):
        return 'ini'
    if e == '.md':
        return 'text'
    if e in ('.md', '.txt', '.json', '.properties', '.vdf'):
        return 'text'
    if e in ('.rwmod', '.zip', '.7z', '.rar'):
        return 'pack'
    return 'other'


@app.route('/api/fs/list')
def api_fs_list():
    """资源管理器：列出目录内容（含大小、修改时间、类型）"""
    path = os.path.abspath(request.args.get('path') or default_root())
    if not os.path.isdir(path):
        return jsonify({'error': '目录不存在: ' + path}), 400
    kinds = request.args.get('kinds') or ''
    show_all = request.args.get('all') == '1'
    dirs, files = [], []
    try:
        names = os.listdir(path)
    except PermissionError:
        return jsonify({'error': '无权限访问: ' + path}), 403
    for name in names:
        if name.startswith('.'):
            continue
        full = os.path.join(path, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        if os.path.isdir(full):
            dirs.append({'name': name, 'path': full, 'kind': 'dir', 'mtime': int(st.st_mtime),
                         'trash': name.startswith(TRASH_PREFIX)})
        else:
            k = file_kind(name)
            if kinds and not show_all and k not in set(kinds.split(',')):
                continue
            files.append({'name': name, 'path': full, 'kind': k, 'size': st.st_size,
                          'mtime': int(st.st_mtime)})
    dirs.sort(key=lambda x: x['name'].lower())
    files.sort(key=lambda x: x['name'].lower())
    parent = os.path.dirname(path)
    return jsonify({'path': path, 'parent': (parent if parent != path else None),
                    'name': os.path.basename(path) or path,
                    'dirs': dirs, 'files': files,
                    'modRoot': find_mod_root(path) or '',
                    'defaultRoot': default_root()})


@app.route('/api/file/raw')
def api_file_raw():
    """资源管理器显示缩略图 / 试听音频"""
    path = request.args.get('path', '')
    if not path or not os.path.isfile(path):
        abort(404)
    ext = os.path.splitext(path)[1].lower()
    if ext not in IMAGE_EXT and ext not in AUDIO_EXT:
        abort(403)
    if os.path.getsize(path) > 24 * 1024 * 1024:
        abort(413)
    resp = send_from_directory(os.path.dirname(path), os.path.basename(path),
                               mimetype=MIME.get(ext, 'application/octet-stream'))
    resp.headers['Cache-Control'] = 'public, max-age=600'
    return resp


# ---------------------------------------------------------------- 贴图解析
# 把 ini 里的图片引用（ROOT:/x.png、SHADOW:y.png、同目录 z.png）解析成真实文件
_ASSET_IDX = {'root': None, 'time': 0, 'map': {}}


def asset_index(root):
    """模组内 文件名(小写) → 完整路径 的索引（只走目录，不解析文件，很快）"""
    now = time.time()
    if _ASSET_IDX['root'] == root and now - _ASSET_IDX['time'] < 240:
        return _ASSET_IDX['map']
    m = {}
    if root and os.path.isdir(root):
        for base, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith('.')]
            for fn in files:
                if os.path.splitext(fn)[1].lower() in ASSET_EXT:
                    m.setdefault(fn.lower(), os.path.join(base, fn))
    _ASSET_IDX.update({'root': root, 'time': now, 'map': m})
    return m


def resolve_asset(ini_path, ref):
    """返回 {kind: file|builtin|none|missing, path?, name?}"""
    ref = (ref or '').strip().strip('"')
    if not ref or ref.upper() in ('NONE', 'AUTO', 'NULL', 'FALSE', 'TRUE', '-'):
        return {'kind': 'none'}
    m = re.match(r'^([A-Za-z_]+):(.*)$', ref)
    prefix, name = (m.group(1).upper(), m.group(2).strip()) if m else ('', ref)
    if prefix == 'SHARED':
        return {'kind': 'builtin', 'name': name, 'note': '游戏内置共享素材'}
    name = name.replace('\\', '/').lstrip('/')
    base_dir = os.path.dirname(os.path.abspath(ini_path)) if ini_path else ''
    root = find_mod_root(base_dir) if base_dir and os.path.isdir(base_dir) else ''
    root = root or base_dir
    tried = []
    cands = []
    if prefix == 'ROOT' and root:
        cands.append(os.path.join(root, name))
    if base_dir:
        cands.append(os.path.join(base_dir, name))
    if root:
        cands.append(os.path.join(root, name))
    for c in cands:
        tried.append(c)
        if os.path.isfile(c):
            return {'kind': 'file', 'path': os.path.abspath(c), 'name': name}
    bn = os.path.basename(name).lower()
    idx = asset_index(root)
    if bn in idx:
        return {'kind': 'file', 'path': idx[bn], 'name': name, 'found': 'byname'}
    return {'kind': 'missing', 'name': name, 'tried': tried[:4]}


@app.route('/api/asset/resolve')
def api_asset_resolve():
    ini = request.args.get('ini') or ''
    raw = request.args.get('refs') or ''
    refs = [x for x in raw.splitlines() if x.strip()]
    if refs:
        return jsonify({'items': [dict(resolve_asset(ini, r), ref=r) for r in refs]})
    return jsonify(resolve_asset(ini, request.args.get('ref') or ''))


@app.route('/api/fs/reveal', methods=['POST'])
def api_fs_reveal():
    """在 Windows 资源管理器里定位这个文件 / 打开这个目录"""
    d = request.get_json(force=True, silent=True) or {}
    path = d.get('path') or ''
    if not os.path.exists(path):
        return jsonify({'error': '路径不存在'}), 404
    try:
        if os.path.isdir(path):
            os.startfile(path)
        else:
            import subprocess
            subprocess.Popen(['explorer', '/select,' + os.path.abspath(path)])
    except Exception as e:  # noqa: BLE001
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True})


@app.route('/api/fs/open', methods=['POST'])
def api_fs_open():
    """用系统默认程序打开文件"""
    d = request.get_json(force=True, silent=True) or {}
    path = d.get('path') or ''
    if not os.path.isfile(path):
        return jsonify({'error': '文件不存在'}), 404
    try:
        os.startfile(path)
    except Exception as e:  # noqa: BLE001
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True})


def safe_name(name):
    name = (name or '').strip().strip('.')
    if not name or any(c in set('\\/:*?"<>|') for c in name):
        return None
    return name


@app.route('/api/fs/mkdir', methods=['POST'])
def api_fs_mkdir():
    d = request.get_json(force=True, silent=True) or {}
    parent = d.get('parent') or ''
    name = safe_name(d.get('name'))
    if not name:
        return jsonify({'error': '文件夹名不合法（不能含 \\ / : * ? " < > |）'}), 400
    if not os.path.isdir(parent):
        return jsonify({'error': '上级目录不存在'}), 404
    full = os.path.join(parent, name)
    if os.path.exists(full):
        return jsonify({'error': '已经存在同名文件/文件夹'}), 400
    try:
        os.makedirs(full)
    except OSError as e:
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True, 'path': full})


@app.route('/api/fs/rename', methods=['POST'])
def api_fs_rename():
    d = request.get_json(force=True, silent=True) or {}
    path = d.get('path') or ''
    name = safe_name(d.get('name'))
    if not os.path.exists(path):
        return jsonify({'error': '路径不存在'}), 404
    if not name:
        return jsonify({'error': '名字不合法'}), 400
    new = os.path.join(os.path.dirname(path), name)
    if os.path.abspath(new) == os.path.abspath(path):
        return jsonify({'ok': True, 'path': path})
    if os.path.exists(new):
        return jsonify({'error': '已经存在同名文件/文件夹'}), 400
    try:
        os.rename(path, new)
    except OSError as e:
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True, 'path': new})


@app.route('/api/fs/trash', methods=['POST'])
def api_fs_trash():
    """软删除：移进 _回收站_时间戳 文件夹，不真删，随时能翻回来"""
    d = request.get_json(force=True, silent=True) or {}
    path = d.get('path') or ''
    if not os.path.exists(path):
        return jsonify({'error': '路径不存在'}), 404
    root = d.get('trashRoot') or find_mod_root(os.path.dirname(path)) or os.path.dirname(path)
    box = os.path.join(root, TRASH_PREFIX + time.strftime('%Y%m%d_%H%M%S'))
    try:
        os.makedirs(box, exist_ok=True)
        target = os.path.join(box, os.path.basename(path))
        n = 2
        while os.path.exists(target):
            target = os.path.join(box, os.path.basename(path) + '_' + str(n))
            n += 1
        import shutil
        shutil.move(path, target)
    except OSError as e:
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True, 'movedTo': target, 'box': box})


@app.route('/api/fs/newfile', methods=['POST'])
def api_fs_newfile():
    d = request.get_json(force=True, silent=True) or {}
    folder = d.get('folder') or ''
    name = safe_name(d.get('name'))
    text = d.get('text') or ''
    if not os.path.isdir(folder):
        return jsonify({'error': '目录不存在'}), 404
    if not name:
        return jsonify({'error': '文件名不合法'}), 400
    if not name.lower().endswith(('.ini', '.template')):
        name += '.ini'
    full = os.path.join(folder, name)
    if os.path.exists(full):
        return jsonify({'error': '已经存在同名文件'}), 400
    try:
        with open(full, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
    except OSError as e:
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True, 'path': full, 'name': name})


@app.route('/api/file/save', methods=['POST'])
def api_file_save():
    d = request.get_json(force=True, silent=True) or {}
    path = d.get('path') or ''
    text = d.get('text')
    if not path or text is None:
        return jsonify({'error': '缺少 path/text'}), 400
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
    except OSError as e:
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True, 'path': path, 'bytes': len(text.encode('utf-8'))})


@app.route('/api/search')
def api_search():
    """在模组目录里搜索包含关键词的 ini 文件（查找单位引用）"""
    q = (request.args.get('q') or '').strip()
    root = os.path.abspath(request.args.get('root') or default_root())
    if not q:
        return jsonify({'hits': []})
    hits = []
    skip_dirs = {'.git', 'node_modules', '__pycache__', '备份'}
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith('.')]
        if len(hits) >= 60:
            break
        for fn in files:
            if not fn.lower().endswith(('.ini', '.template', '.md')):
                continue
            full = os.path.join(base, fn)
            try:
                txt = read_text(full)
            except OSError:
                continue
            if q in txt:
                hits.append({'path': full, 'name': fn,
                             'dir': os.path.relpath(base, root)})
                if len(hits) >= 60:
                    break
    return jsonify({'hits': hits, 'root': root})


@app.route('/api/health')
def api_health():
    m = load_meta()
    return jsonify({'ok': True, 'meta': bool(m), 'port': PORT,
                    'root': default_root(), 'project': APP_DIR, 'res': RES,
                    'lan': LAN, 'ips': local_ips(), 'frozen': FROZEN,
                    'sections': len(m['sections']) if m else 0})


@app.route('/api/net')
def api_net():
    """给界面显示「手机访问这个地址」"""
    ips = local_ips()
    return jsonify({
        'lan': LAN, 'port': PORT, 'ips': ips,
        'urls': ['http://%s:%d/' % (ip, PORT) for ip in ips],
        'local': 'http://127.0.0.1:%d/' % PORT,
        'frozen': FROZEN,
    })


# ================================================================ 背包
# 把「一堆键」或「一个完整的段」存成可复用的模块，之后一键追加到任意单位文件里

def load_bag():
    try:
        with open(BACKPACK, encoding='utf-8') as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get('items'), list):
            return d
    except (OSError, ValueError):
        pass
    return {'items': []}


def save_bag(d):
    os.makedirs(DATA, exist_ok=True)
    with open(BACKPACK, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=1)


@app.route('/api/backpack')
def api_bag_get():
    return jsonify(load_bag())


@app.route('/api/backpack/add', methods=['POST'])
def api_bag_add():
    item = request.get_json(force=True, silent=True) or {}
    if not item.get('name') and not item.get('payload'):
        return jsonify({'error': '缺少 name/payload'}), 400
    d = load_bag()
    item.setdefault('id', 'bag_%d' % int(time.time() * 1000))
    item['added'] = time.strftime('%Y-%m-%d %H:%M')
    d['items'].insert(0, item)
    save_bag(d)
    return jsonify({'ok': True, 'id': item['id'], 'count': len(d['items'])})


@app.route('/api/backpack/update', methods=['POST'])
def api_bag_update():
    p = request.get_json(force=True, silent=True) or {}
    d = load_bag()
    for it in d['items']:
        if it.get('id') == p.get('id'):
            if p.get('name') is not None:
                it['name'] = p['name']
            if p.get('note') is not None:
                it['note'] = p['note']
            save_bag(d)
            return jsonify({'ok': True})
    return jsonify({'error': '找不到这个背包条目'}), 404


@app.route('/api/backpack/delete', methods=['POST'])
def api_bag_delete():
    p = request.get_json(force=True, silent=True) or {}
    d = load_bag()
    n = len(d['items'])
    d['items'] = [it for it in d['items'] if it.get('id') != p.get('id')]
    save_bag(d)
    return jsonify({'ok': True, 'removed': n - len(d['items']), 'count': len(d['items'])})


# ================================================================ 模组体检
ASSET_EXT = ('.png', '.jpg', '.jpeg', '.bmp', '.gif', '.ogg', '.wav', '.mp3', '.m4a')
REF_FILE_RE = re.compile(r'[^\s,;:"\'\[\]{}()=*]+\.(?:png|jpg|jpeg|bmp|gif|ogg|wav|mp3|m4a)', re.I)
SECTION_RE = re.compile(r'^\s*\[([^\]]+)\]\s*$')
BUILTIN_RES = {'credits', 'energy', 'hp', 'shield', 'ammo', 'creditsResource',
               'setFlag', 'unsetFlag', 'hasFlag', 'hasMissingFlag'}
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '备份', 'System Volume Information', '$RECYCLE.BIN'}
_SCAN_CACHE = {'key': None, 'time': 0, 'data': None}
SCAN_TTL = 180          # 秒，同一目录 3 分钟内复用结果
SCAN_MAX_FILES = 30000
SCAN_BUDGET = 45.0      # 秒，超时返回已扫描部分


def parse_sections(text):
    """轻量解析：[段名] → {键: 值}"""
    out = []
    cur = None
    for line in text.splitlines():
        t = line.strip()
        if not t or t.startswith('#') or t.startswith(';'):
            continue
        m = SECTION_RE.match(t)
        if m:
            cur = (m.group(1), {})
            out.append(cur)
            continue
        if cur is None:
            cur = ('', {})
            out.append(cur)
        i = t.find(':')
        j = t.find('=')
        if i < 0 or (0 <= j < i):
            i = j
        if i > 0:
            cur[1][t[:i].strip()] = t[i + 1:].strip()
    return out


def base_name(s):
    s = str(s).replace('\\', '/')
    return s.rsplit('/', 1)[-1]


def scan_mod(root, force=False):
    now = time.time()
    if not force and _SCAN_CACHE['key'] == root and now - _SCAN_CACHE['time'] < SCAN_TTL:
        d = dict(_SCAN_CACHE['data'])
        d['cached'] = True
        return d

    meta = load_meta() or {}
    builtin_assets = set()
    for key in ('builtinImage', 'builtinSound'):
        for it in (meta.get('enums', {}).get(key) or {}).get('items', []):
            builtin_assets.add(base_name(it['v']).lower())

    start = time.time()
    truncated = False
    files_ini = []
    assets = {}
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith('.')]
        if time.time() - start > SCAN_BUDGET or len(files_ini) > SCAN_MAX_FILES:
            truncated = True
            break
        for fn in files:
            full = os.path.join(base, fn)
            rel = os.path.relpath(full, root)
            if base == HERE:            # 别把编写器自己的文件算进去
                continue
            low = fn.lower()
            if low.endswith(ASSET_EXT):
                try:
                    size = os.path.getsize(full)
                except OSError:
                    size = 0
                rec = assets.setdefault(low, {'name': fn, 'rel': rel, 'size': size, 'copies': 0})
                rec['copies'] += 1
            elif low.endswith(('.ini', '.template', '.md')):
                # .md 也参与：不少模组把特效/模板库写在 .md 里，靠 copyFrom 引用
                files_ini.append((rel, full))

    refs = set()          # 被 ini 引用过的素材文件名（小写）
    units, effects, actions, globals_, templates, animations = {}, {}, {}, {}, {}, {}
    allunits = None
    allunits_path = None
    used_globals = {}     # 全局变量名 → 用到的文件数
    for rel, full in files_ini:
        try:
            if os.path.getsize(full) > 12 * 1024 * 1024:
                continue
            text = read_text(full)
        except OSError:
            continue
        for m in REF_FILE_RE.finditer(text):
            refs.add(base_name(m.group(0)).lower())
        for name, kv in parse_sections(text):
            n = name.strip()
            low = n.lower()
            if low == 'core':
                u = kv.get('name')
                if u:
                    units.setdefault(u.strip(), {'name': u.strip(), 'rel': rel})
            elif low.startswith('effect_'):
                effects.setdefault(n[7:], {'name': n[7:], 'rel': rel, 'keys': len(kv)})
            elif low.startswith('hiddenaction_'):
                key = n[len('hiddenAction_'):]
                actions.setdefault(key, {'name': key, 'rel': rel, 'hidden': True})
            elif low.startswith('action_'):
                key = n[len('action_'):]
                actions.setdefault(key, {'name': key, 'rel': rel, 'hidden': False})
            elif low.startswith('global_resource_') or low.startswith('resource_'):
                # 注意：global_resource_ 前缀里自己带下划线，不能按第一个下划线切
                pref = 'global_resource_' if low.startswith('global_resource_') else 'resource_'
                key = n[len(pref):]
                globals_.setdefault(key, {
                    'name': key, 'rel': rel, 'section': n,
                    'displayName': kv.get('displayName', ''),
                    'displayNameShort': kv.get('displayNameShort', ''),
                    'displayColor': kv.get('displayColor', ''),
                    'iconImage': kv.get('iconImage', ''),
                    'hidden': kv.get('hidden', ''),
                    'global': pref == 'global_resource_',
                    'stackHorizontal': kv.get('stackHorizontal', ''),
                })
            elif low.startswith('animation_'):
                animations.setdefault(n, {'name': n, 'rel': rel, 'path': full,
                                          'keys': len(kv), 'onActions': kv.get('onActions', '')})
            elif low.startswith('template_'):
                templates.setdefault(n[len('template_'):], {'name': n[len('template_'):], 'rel': rel, 'keys': list(kv.keys())})
        # 全局变量使用情况：addResources / price / generation_resources / resourceUsage
        for name, kv in parse_sections(text):
            for k in ('addResources', 'price', 'resourceUsage', 'generation_resources',
                      'setResourcesWithLogic', 'borrowResourcesWhileAlive', 'borrowResourcesWhileBuilt'):
                v = kv.get(k)
                if not v:
                    continue
                for part in v.split(','):
                    part = part.strip()
                    for mm in re.finditer(r'([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)\s*=', part):
                        nm = mm.group(1)
                        if nm not in BUILTIN_RES and nm.lower() not in ('core', 'self', 'memory'):
                            used_globals[nm] = used_globals.get(nm, 0) + 1
        if os.path.basename(full).lower() == 'all-units.template':
            allunits_path = full
            secs = []
            for name, kv in parse_sections(text):
                secs.append({'name': name, 'keys': [{'k': k, 'v': v} for k, v in kv.items()]})
            allunits = {'rel': rel, 'path': full,
                        'sections': [s for s in secs if s['name'] or s['keys']],
                        'lines': text.count('\n') + 1,
                        'chars': len(text)}

    unused = []
    for low, rec in assets.items():
        if low not in refs:
            unused.append({'name': rec['name'], 'rel': rec['rel'], 'size': rec['size'],
                           'copies': rec['copies']})
    unused.sort(key=lambda x: -x['size'])

    missing = []
    for r in sorted(refs):
        if r in assets or r in builtin_assets:
            continue
        missing.append({'name': r})

    # 被使用但从没定义过的全局变量
    ghost_globals = [{'name': g, 'uses': c} for g, c in used_globals.items() if g not in globals_]
    ghost_globals.sort(key=lambda x: -x['uses'])

    data = {
        'ok': True, 'root': root, 'cached': False, 'truncated': truncated,
        'files': len(files_ini), 'seconds': round(time.time() - start, 1),
        'assets': {
            'total': len(assets), 'unused': unused[:400], 'unusedCount': len(unused),
            'unusedBytes': sum(a['size'] for a in unused),
            'missing': missing[:200], 'missingCount': len(missing),
            'index': sorted(assets.keys()),      # 模组里存在的素材文件名（小写），用于判断引用是否有效
        },
        'units': sorted(units.values(), key=lambda x: x['name'])[:5000],
        'effects': sorted(effects.values(), key=lambda x: x['name'])[:5000],
        'actions': sorted(actions.values(), key=lambda x: x['name'])[:5000],
        'globals': sorted(globals_.values(), key=lambda x: x['name']),
        'ghostGlobals': ghost_globals[:200],
        'templates': sorted(templates.values(), key=lambda x: x['name']),
        'animations': sorted(animations.values(), key=lambda x: (x['rel'], x['name']))[:3000],
        'counts': {'units': len(units), 'effects': len(effects), 'actions': len(actions),
                   'globals': len(globals_), 'templates': len(templates), 'animations': len(animations)},
        'allUnits': allunits,
        'allUnitsPath': allunits_path,
        'builtinAssets': len(builtin_assets),
    }
    _SCAN_CACHE.update({'key': root, 'time': now, 'data': data})
    return data


def find_mod_root(path):
    """从某个目录往上找模组根（认 all-units.template / mod-info.TXT / modinfo.json）"""
    cur = os.path.abspath(path)
    for _ in range(8):
        try:
            names = {n.lower() for n in os.listdir(cur)}
        except OSError:
            return None
        if names & {'all-units.template', 'mod-info.txt', 'modinfo.json'}:
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent
    return None


@app.route('/api/mod/scan')
def api_mod_scan():
    asked = os.path.abspath(request.args.get('root') or default_root())
    if not os.path.isdir(asked):
        return jsonify({'error': '目录不存在: ' + asked}), 400
    force = request.args.get('refresh') in ('1', 'true')
    # 传进来的可能只是模组里的某个单位文件夹：自动往上找到模组根再扫，
    # 否则全局变量/素材引用会判断成"整个模组都没有"（假报错）
    root = asked
    up = find_mod_root(asked)
    if up and os.path.abspath(up) != asked:
        root = os.path.abspath(up)
        _SCAN_CACHE['key'] = None
    try:
        data = scan_mod(root, force)
    except OSError as e:
        return jsonify({'error': str(e)}), 500
    data['askedRoot'] = asked
    # 如果当前目录只是模组里的一个子文件夹，告诉界面真正的模组根在哪
    if not data.get('allUnitsPath') and not data.get('truncated'):
        better = find_mod_root(root)
        if better and os.path.abspath(better) != root:
            data['suggestRoot'] = better
    return jsonify(data)


def open_browser():
    webbrowser.open(f'http://127.0.0.1:{PORT}/')


def port_in_use(port):
    """Windows 上 SO_REUSEADDR 允许重复绑定，直接试连更可靠"""
    import socket
    s = socket.socket()
    s.settimeout(0.4)
    try:
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


def main():
    global PORT, LAN
    # 命令行开关：--lan 局域网模式 / --port 8760 / --no-browser
    argv = sys.argv[1:]
    if '--lan' in argv or '-l' in argv:
        LAN = True
    if '--port' in argv:
        try:
            PORT = int(argv[argv.index('--port') + 1])
        except (IndexError, ValueError):
            sys.exit('--port 后面要跟端口号，例如 --port 8760')

    print('=' * 60)
    print('  铁锈代码编写器 —— 诺瓦御科 v1.15 代码表图形化工具')
    print('=' * 60)
    if load_meta() is None:
        print('[!] 未找到 data/code_table.json')
        print('    请先运行：python build_data.py')
    # 端口被占用时自动往后找一个（比如上一次没关干净）
    if port_in_use(PORT):
        old = PORT
        for p in range(PORT + 1, PORT + 11):
            if not port_in_use(p):
                PORT = p
                print(f'[i] 端口 {old} 已被占用（可能是上次没关掉的窗口），改用 {PORT}')
                break
        else:
            sys.exit(f'端口 {old}-{old + 10} 都被占用，请先关闭其它编写器窗口')
    print(f'  项目目录：{HERE}')
    print(f'  模组目录：{default_root()}   （在界面里选过之后会记住）')
    print(f'  本机访问：http://127.0.0.1:{PORT}/')
    print(f'  数据目录：{DATA}')
    if LAN:
        ips = local_ips()
        if ips:
            print('  ── 局域网模式已开启：手机/平板连同一个 WiFi，浏览器打开 ──')
            for ip in ips:
                print(f'      http://{ip}:{PORT}/')
            print('      （手机上用「添加到主屏幕」就能像 App 一样打开）')
            print('      如果连不上，检查 Windows 防火墙是否放通了这个端口')
        else:
            print('  [!] 没找到局域网 IP，可能是没连网；仅本机可用')
    else:
        print('  想让手机也能用：双击「启动-局域网.bat」或用 python server.py --lan')
    print('  (Ctrl+C 退出)')
    print('=' * 60)
    if os.environ.get('RT_NO_BROWSER') != '1':
        threading.Timer(1.2, open_browser).start()
    app.run(host=('0.0.0.0' if LAN else '127.0.0.1'), port=PORT, debug=False, threaded=True)


if __name__ == '__main__':
    main()
