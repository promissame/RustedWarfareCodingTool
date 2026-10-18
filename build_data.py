# -*- coding: utf-8 -*-
"""
build_data.py —— 把《诺瓦御科：v1.15代码表.xlsx》转换成编写器使用的 code_table.json

用法：
    python build_data.py                 # 自动在上级目录/当前目录寻找 xlsx
    python build_data.py 路径.xlsx       # 指定代码表

输出：data/code_table.json
"""
import json
import os
import re
import sys
import datetime

try:
    import openpyxl
except ImportError:
    sys.exit('缺少 openpyxl，请先执行：pip install openpyxl')

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, 'data')

# ---------------------------------------------------------------- 工具函数

def cell(ws, r, c):
    v = ws.cell(r, c).value
    if v is None:
        return None
    s = str(v).replace('\r\n', '\n').strip()
    return s or None


def find_xlsx():
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        return sys.argv[1]
    # 依次在：本目录 / 代码表子目录 / 上级目录 / 上级的代码表子目录 里找代码表
    search_dirs = [HERE, os.path.join(HERE, '代码表'),
                   os.path.dirname(HERE), os.path.join(os.path.dirname(HERE), '代码表')]
    search_dirs = [d for d in search_dirs if os.path.isdir(d)]
    cands = []
    for d in search_dirs:
        for f in os.listdir(d):
            if f.lower().endswith(('.xlsx', '.xlsm')) and '代码表' in f:
                cands.append(os.path.join(d, f))
    if not cands:
        for d in search_dirs:
            for f in os.listdir(d):
                if f.lower().endswith(('.xlsx', '.xlsm')) and not f.startswith('~'):
                    cands.append(os.path.join(d, f))
    if not cands:
        sys.exit('未找到代码表 xlsx，请把 xlsx 放到编写器目录或上级目录，或作为参数传入')
    return cands[0]


# --------------------------------------------------------- 1. 单位代码表

VALUE_KIND = [
    # (正则, 编辑器类型) —— 顺序敏感：先精确匹配复数/列表类型
    (r'^integers$|^integer\(s\)$|^pointeger', 'numlist'),
    (r'^string\(s\)$|^tags$|^tag list$|^list$|^fields$|^memories$|^actions$|^units$|^effects$|^effect\(s\) ref$|^effect ref list$|^price\(s\)$|^unit ref/unit$', 'list'),
    (r'^bool|^boolean|^LogicBoolean$|^logic bool', 'bool'),
    (r'^LogicFloat|^logic float', 'logic-number'),
    (r'^LogicOperation|^logic', 'logic'),
    (r'^integer|^int\b|^bool/integer|^logic integer', 'integer'),
    (r'^special value', 'special'),      # 特殊写法（canBuild_#_name / animation_X_Y 等），填字符串
    (r'^float|^number|^compare value', 'float'),
    (r'^price|^customPrice', 'price'),
    (r'^time', 'time'),
    (r'^color', 'color'),
    (r'^image|^file|^audios|oggs?/wav', 'asset'),
    (r'(?i)^resources?$|^customResources?$|^resource ref$', 'resources'),
    (r'^unit|^turret ref|^projectile ref|^effect|^action ref|^animation ref|^marker|^unit / marker', 'ref'),
    (r'^string|^LocaleString|^display type|^dir$|^connect$', 'string'),
]

# 某些键需要专门编辑器（覆盖自动推断）
KEY_OVERRIDE = {
    'movementType': 'enum:movementType',
    'effectOnDeath': 'string',
    'tags': 'tags',
    'altNames': 'tags',
    'aiTags': 'tags',
    'searchTags': 'tags',
    'displayColor': 'color',
    'flareColour': 'color',
    'colour': 'color',
    'turretSize': 'integer',
    'image': 'asset',
    'action_#_[actionKey]': 'special',
    'canBuild_#_[canBuildKey]': 'special',
    'animation_TYPE_[animationKey]': 'special',
}


def infer_kind(vtype, code):
    if code in KEY_OVERRIDE:
        return KEY_OVERRIDE[code]
    v = (vtype or '').strip()
    for pat, kind in VALUE_KIND:
        if re.search(pat, v, re.I):
            return kind
    return 'string'


def extract_units(wb):
    ws = wb['单位代码']
    sections = []          # 顶层 ini 段
    cur_sec = None
    cur_grp = None
    header_codes = {'代码', 'key代码'}

    def new_section(raw, title):
        s = {'raw': raw, 'title': title, 'id': sec_id(raw), 'groups': []}
        sections.append(s)
        return s

    for r in range(1, ws.max_row + 1):
        code = cell(ws, r, 2)
        trans = cell(ws, r, 3)
        desc = cell(ws, r, 4)
        ex = cell(ws, r, 5)
        vtype = cell(ws, r, 6)
        if all(x is None for x in (code, trans, desc, ex, vtype)):
            continue

        c = code or ''
        t = trans or ''
        d = desc or ''

        # 段标记：第 4 列是 [xxx]
        if d.startswith('[') and len(d) < 60:
            cur_sec = new_section(d, c or d)
            cur_grp = None
            continue

        # 分隔线 ++++++++++
        if len(c) >= 4 and set(c) <= set('+=-'):
            name = d if d and set(d) <= set('+=-') else d
            if name and set(name) <= set('+=-+'):
                cur_grp = None          # 无名分隔：并入上一组
                continue
            if cur_sec is None:
                cur_sec = new_section('[core]', '核心')
            cur_grp = {'name': name, 'entries': []}
            cur_sec['groups'].append(cur_grp)
            continue

        # 表头行
        if c in header_codes or t == '代码翻译':
            continue

        if cur_sec is None:
            cur_sec = new_section('[core]', '核心')
        if cur_grp is None:
            cur_grp = {'name': '', 'entries': []}
            cur_sec['groups'].append(cur_grp)

        cur_grp['entries'].append({
            'code': c,
            'trans': t,
            'desc': d,
            'ex': ex or '',
            'vtype': vtype or '',
            'kind': infer_kind(vtype, c),
        })

    # 清理空组
    for s in sections:
        s['groups'] = [g for g in s['groups'] if g['entries']]
    return [s for s in sections if s['groups']]


def sec_id(raw):
    """[turret_NAME（非必要请填1-31的数字）] -> turret ; [global_resource_NAME] -> global_resource"""
    m = re.match(r'\[([A-Za-z_#]+)', raw or '')
    if not m:
        return (raw or '').strip('[]')
    name = m.group(1).rstrip('_')
    name = re.sub(r'_?NAME$', '', name)
    return name or 'core'


# --------------------------------------------------------- 2. 参考值（枚举）

# 表头文字 -> 枚举 id（用于表单下拉框）
ENUM_ALIAS = {
    '内置爆炸效果': 'explosionEffect',
    '运动类型': 'movementType',
    '行动框类型': 'actionDisplayType',
    '路径点类型': 'waypointType',
    '移动方式': 'movementChange',
    '效果优先级': 'effectPriority',
    'aiUse可填值': 'aiUse',
    '内置音效': 'builtinSound',
    '内置图像': 'builtinImage',
    'shared内的可用图像': 'sharedImage',
    '队伍类型': 'teamRelation',
    '动画触发条件': 'animationCondition',
    '内存(memory)的种类': 'memoryType',
    '内存数组': 'memoryArray',
    '逻辑参数': 'logicParam',
    '贴花绘制图层类型': 'decalLayer',
    '单位的可控制状态': 'controllableState',
    '地图位置产生指定单位': 'mapSpawnPos',
    '“自动触发事件”(autoTriggerOnEvent)的可填事件': 'autoTriggerEvent',
    '自动触发事件': 'autoTriggerEvent',
    'AI不同难度资金比例：': 'aiDifficultyMoney',
    '代码可用内置图像': 'builtinImage',
    '单位表': 'unitListDex',
    'I盘（i:）引用表': 'iconReference',
    'I盘(i:)引用表': 'iconReference',
}


def has_cjk(s):
    return any('\u4e00' <= ch <= '\u9fff' for ch in (s or ''))


def looks_like_code(s):
    """own / NONE / beforeBody / menus.front.buyNow 这类值"""
    if not s or has_cjk(s):
        return False
    return bool(re.match(r'^[A-Za-z_][A-Za-z0-9_.\-]*$', s.strip()))


def extract_reference(wb):
    """从 参考值 表抽出「表头 + 竖列值」的块"""
    ws = wb['参考值']
    maxr, maxc = ws.max_row, ws.max_column
    enums = {}
    blocks = []
    raw_blocks = []

    for c in range(2, maxc + 1):
        r = 1
        while r <= maxr:
            head = cell(ws, r, c)
            if head is None:
                r += 1
                continue
            values = []
            rr = r + 1
            while rr <= maxr and cell(ws, rr, c) is not None:
                values.append((rr, cell(ws, rr, c)))
                rr += 1
            if not values:
                r = rr
                continue

            # 翻译列：只在右侧、由近到远找覆盖率足够的列
            tcol, best = None, 0
            for dist in range(1, 7):
                tc = c + dist
                if tc > maxc:
                    break
                hits = sum(1 for (rv, _) in values if cell(ws, rv, tc) is not None)
                if hits >= max(1, int(len(values) * 0.6)):
                    tcol, best = tc, hits
                    break

            vcol, dcol = c, tcol
            # 若主列是中文而另一列像代码，则交换（表中方向不统一）
            sample = [v for (_, v) in values[:8] if v]
            if sample and sum(1 for x in sample if has_cjk(x)) > len(sample) * 0.6 and tcol:
                tsample = [cell(ws, rv, tcol) for (rv, _) in values[:8]]
                tsample = [x for x in tsample if x]
                if tsample and sum(1 for x in tsample if looks_like_code(x)) > len(tsample) * 0.6:
                    vcol, dcol = tcol, c

            pairs = []
            if len(values) == 1 and '\n' in values[0][1]:
                vals = [x.strip() for x in (cell(ws, values[0][0], vcol) or '').split('\n')]
                tv = cell(ws, values[0][0], dcol) if dcol else None
                trans = [x.strip() for x in tv.split('\n')] if tv and '\n' in tv else \
                        ([x.strip() for x in tv.split('\n')] if tv else [])
                for i, v in enumerate(vals):
                    if not v:
                        continue
                    pairs.append({'v': v, 't': trans[i] if i < len(trans) else ''})
            else:
                for (rv, _) in values:
                    v = cell(ws, rv, vcol)
                    tv = cell(ws, rv, dcol) if dcol else None
                    if v and '\n' in v and tv and '\n' in tv and len(v.split('\n')) == len(tv.split('\n')):
                        vs = [x.strip() for x in v.split('\n')]
                        ts = [x.strip() for x in tv.split('\n')]
                        for i, x in enumerate(vs):
                            if x:
                                pairs.append({'v': x, 't': ts[i] if i < len(ts) else ''})
                    elif v:
                        pairs.append({'v': v, 't': tv or ''})
            if len(pairs) >= 2:
                raw_blocks.append({'col': c, 'row': r, 'title': head, 'items': pairs})
            r = rr

    # 去掉块内混入的子标题（同列后续块的标题 / 已知小标题）
    SUB_HEADERS = {'shared内的可用图像', 'dex内部', '外部', '==', '代码可用内置图像'}
    titles = {(b['col'], b['title']) for b in raw_blocks}
    for b in raw_blocks:
        items = [it for it in b['items']
                 if (b['col'], it['v']) not in titles and it['v'] not in SUB_HEADERS]
        if len(items) >= 2:
            b['items'] = items
            blocks.append(b)
            enum_id = ENUM_ALIAS.get(b['title'])
            if enum_id and enum_id not in enums:
                enums[enum_id] = {'title': b['title'], 'items': items}
    # 单位表：dex内部(30列) + 外部(39列) 合并
    if 'unitListDex' in enums:
        for b in blocks:
            if b['col'] == 39 and len(b['items']) > 10:
                enums['unitListDex']['items'] += b['items']
                break
    return enums, blocks


def extract_sheet_table(wb, name):
    """地图代码 / 其他：按行导出成手册"""
    ws = wb[name]
    table = []
    for r in range(1, ws.max_row + 1):
        row = []
        for c in range(1, ws.max_column + 1):
            row.append(cell(ws, r, c) or '')
        while row and not row[-1]:
            row.pop()
        if row and any(row):
            table.append(row)
    return table


# ---------------------------------------------------------------- 主流程

def main():
    path = find_xlsx()
    print('读取代码表：', path)
    wb = openpyxl.load_workbook(path, data_only=True)

    units = extract_units(wb)
    enums, ref_blocks = extract_reference(wb)
    maps = extract_sheet_table(wb, '地图代码')

    n_entries = sum(len(g['entries']) for s in units for g in s['groups'])
    # 代码表 xlsx 没登记、但实际存在的键（补进索引，编辑器才有正确的类型/说明）
    EXTRA = {
        'turret': [{'code': 'drawOverBody', 'trans': '绘制在主体之上', 'vtype': 'bool', 'kind': 'bool',
                    'desc': '是否把炮塔绘制在主体之上。默认 true。填 false 时炮塔画在主体下面（比如穿甲炮管插进车体）。',
                    'ex': 'drawOverBody: false'}],
        'leg_#': [{'code': 'drawOverBody', 'trans': '绘制在主体之上', 'vtype': 'bool', 'kind': 'bool',
                   'desc': '是否把这条腿/胳膊绘制在主体之上。默认 false（在主体之下）。',
                   'ex': 'drawOverBody: true'}],
    }
    for sec in units:
        extra = EXTRA.get(sec['id'])
        if not extra:
            continue
        # 每段只补一次（加到第一个组），避免重复
        has = any(e['code'] == 'drawOverBody' for g in sec['groups'] for e in g['entries'])
        if not has and sec['groups']:
            for e in extra:
                e = dict(e, _order=99000)
                sec['groups'][0]['entries'].append(e)
    out = {
        'source': os.path.basename(path),
        'version': re.findall(r'v[\d.]+', os.path.basename(path)) or [''],
        'generated': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
        'sections': units,
        'enums': enums,
        'reference_blocks': ref_blocks,
        'mapCodes': maps,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    dst = os.path.join(OUT_DIR, 'code_table.json')
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'段数 {len(units)}，代码条目 {n_entries}，枚举 {len(enums)}，参考块 {len(ref_blocks)}')
    print('已写出：', dst, f'({os.path.getsize(dst)/1024:.0f} KB)')


if __name__ == '__main__':
    main()
