/* ============================================================
   动画制作器（Animation Studio）
   —— 关键帧编辑 + 时间轴预览 + 写入代码 + 从文件/背包/模组载入
   ------------------------------------------------------------
   语法来自代码表 [animation_NAME] 段：
     arm1_5s: {x: 5, dir: 90}
     leg1_5s: {x: 5, dir: 90, alpha: 0.6}
     body_4s: {frame: 4, scale: 0.5}      （主体只允许 frame / scale）
     effect_2s: {x: 0, y: 5, name: explode}
     turret1_5s: {x: 5, y: 90}
   ============================================================ */
'use strict';

const PART_PROPS = {
  body: ['frame', 'scale'],
  turret: ['x', 'y'],
  leg: ['x', 'y', 'dir', 'alpha'],
  arm: ['x', 'y', 'dir', 'alpha'],
  effect: ['x', 'y'],
};
const KEY_RE = /^(body|turret\d*|leg\d*|arm\d*|effect\d*)_([\d.]+)(s?)$/i;
const ON_ACTIONS = ['idle', 'move', 'attack', 'build', 'underConstruction', 'underConstructionWithLinkedBuiltTime',
  'queuedUnits', 'repair', 'reclaim', 'created', 'Unknown'];

const STUDIO = {
  name: 'animation_1',
  params: {},
  keys: [],          // {time:Number, part:'body'|'turret1'|..., props:{}, ease?:String, bezier?:[]}
  playing: true,
  t: 0,
  speed: 1,
  loop: true,
  last: 0,
  raf: 0,
  selKey: null,      // 当前选中的关键帧对象
  bake: true,        // 写入代码时把缓动烘焙成中间关键帧
  bakeStep: 0.05,    // 烘焙采样步长（秒）
  grid: 5,           // 按住 Ctrl 拖动时的吸附网格
  zoom: 1, panX: 0, panY: 0,
  history: [], hIndex: -1, _hApplying: false, _hTimer: 0,
  pps: 120,          // 时间轴：每秒像素
  snap: true,        // 时间轴吸附
  tlCollapsed: false,
  stTab: 'keys',
  formOpen: true,      // 关键帧编辑表单是否展开     // 右侧面板：keys / frames
};

/* ---------------- 解析 / 序列化 ---------------- */
function parseAnimSection(sec) {
  const kv = {};
  for (const e of sec.entries) if (e.key) kv[e.key] = e.value;
  const params = {
    onActions: kv.onActions || '', onActionsQueuedUnitPlayAt: kv.onActionsQueuedUnitPlayAt || '',
    blendIn: kv.blendIn || '', blendOut: kv.blendOut || '',
    KeyframeTimeScale: kv.KeyframeTimeScale || kv.keyframeTimeScale || '',
    pingPong: kv.pingPong || '', playbackRate: kv.playbackRate || '',
    direction_units: kv.direction_units || '', direction_strideX: kv.direction_strideX || '',
    direction_strideY: kv.direction_strideY || '', direction_starting: kv.direction_starting || '',
    start: kv.start || '', end: kv.end || '', scale_start: kv.scale_start || '',
    scale_end: kv.scale_end || '', speed: kv.speed || '',
  };
  const keys = [];
  for (const k in kv) {
    const m = String(k).match(KEY_RE);
    if (!m) continue;
    const part = m[1].toLowerCase();
    const time = parseFloat(m[2]) * (m[3] ? 1 : (1 / 60));   // 没写 s 的按帧算
    keys.push({ time: time, part: part, props: parseProps(kv[k]) });
  }
  keys.sort((a, b) => a.time - b.time || partOrder(a.part) - partOrder(b.part));
  return { params: params, keys: keys };
}

function parseProps(text) {
  const out = {};
  const s = String(text || '').trim();
  const inner = s.replace(/^\{/, '').replace(/\}$/, '');
  for (const part of inner.split(',')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (/^-?[\d.]+$/.test(v)) v = parseFloat(v);
    if (k) out[k] = v;
  }
  return out;
}
function fmtProps(props) {
  const order = ['x', 'y', 'frame', 'scale', 'alpha', 'dir', 'name'];
  const keys = order.filter(k => props[k] !== undefined && props[k] !== '' && props[k] !== null);
  for (const k in props) if (keys.indexOf(k) < 0 && props[k] !== '' && props[k] !== null) keys.push(k);
  return '{' + keys.map(k => {
    let v = props[k];
    if (typeof v === 'number' && isFinite(v)) v = Math.round(v * 1000) / 1000;
    return k + ': ' + v;
  }).join(', ') + '}';
}
function partOrder(p) {
  if (p === 'body') return 0;
  if (p.startsWith('turret')) return 1;
  if (p.startsWith('leg')) return 2;
  if (p.startsWith('arm')) return 3;
  return 4;
}
function fmtTime(t) {
  return (Math.round(t * 1000) / 1000) + 's';
}

/* ---------------- 非线性缓动 ----------------
 * RW 本体只会在关键帧之间做线性插值，所以编辑器里的缓动曲线有两个用途：
 *   1. 制作器预览按曲线采样；
 *   2. 写入/复制代码时把曲线烘焙成中间关键帧，游戏里也能得到同样的加减速。
 */
const EASE_PRESETS = {
  linear: { label: '线性', bez: [0, 0, 1, 1] },
  easeIn: { label: '缓入', bez: [0.42, 0, 1, 1] },
  easeOut: { label: '缓出', bez: [0, 0, 0.58, 1] },
  easeInOut: { label: '缓入缓出', bez: [0.42, 0, 0.58, 1] },
  smooth: { label: '柔和', bez: [0.4, 0, 0.2, 1] },
  backIn: { label: '回弹入', bez: [0.36, 0, 0.66, -0.56] },
  backOut: { label: '回弹出', bez: [0.34, 1.56, 0.64, 1] },
  bounce: { label: '弹跳' },
  custom: { label: '自定义曲线', bez: [0.42, 0, 0.58, 1] },
};
function easeLabel(k) {
  if (!k) return '线性';
  const id = k.ease || 'linear';
  if (id === 'custom') {
    const b = k.bezier;
    return b && b.length === 4 ? '自定义 ' + b.map(v => +v.toFixed(2)).join(',') : '自定义曲线';
  }
  return (EASE_PRESETS[id] && EASE_PRESETS[id].label) || id;
}
function easeBez(k) {
  if (!k) return EASE_PRESETS.linear.bez;
  if (k.ease === 'custom' && Array.isArray(k.bezier) && k.bezier.length === 4) {
    return k.bezier.map(v => +v);
  }
  const p = EASE_PRESETS[k.ease || 'linear'];
  return (p && p.bez) || EASE_PRESETS.linear.bez;
}
function bounceOut(p) {
  const n = 7.5625, d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) { p -= 1.5 / d; return n * p * p + 0.75; }
  if (p < 2.5 / d) { p -= 2.25 / d; return n * p * p + 0.9375; }
  p -= 2.625 / d; return n * p * p + 0.984375;
}
function cubicBezierAt(x, x1, y1, x2, y2) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = t => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = t => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0, hi = 1;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid; else hi = mid;
  }
  return by((lo + hi) / 2);
}
/** 0~1 的进度 → 缓动后的进度（可超出 0~1，用于回弹） */
function easeValue(p, key) {
  p = Math.max(0, Math.min(1, p));
  const id = (key && key.ease) || 'linear';
  if (id === 'linear') return p;
  if (id === 'bounce') return bounceOut(p);
  const b = easeBez(key);
  return cubicBezierAt(p, b[0], b[1], b[2], b[3]);
}
function easedKeys(keys) {
  return (keys || []).map(k => Object.assign({}, k, {
    ease: k.ease || 'linear',
    bezier: k.ease === 'custom' ? (k.bezier || EASE_PRESETS.custom.bez) : undefined,
  }));
}
/** 一段动画的缓动：优先用段首帧；段首为线性时用段尾帧（末帧也能控制进入它的那一段） */
function segmentEase(a, b) {
  if (a && a.ease && a.ease !== 'linear') return a;
  if (b && b.ease && b.ease !== 'linear') return b;
  return a || b;
}

/** 把缓动曲线按固定步长采样成中间关键帧（RW 只支持线性插值） */
function bakeAnimKeys(keys, stepSec) {
  const src = (keys || []).slice();
  const step = normalizeBakeStep(stepSec !== undefined ? stepSec : STUDIO.bakeStep);
  const out = [];
  const byPart = {};
  for (const k of src) {
    if (!k || !k.part) continue;
    (byPart[k.part] = byPart[k.part] || []).push(k);
  }
  for (const part in byPart) {
    const list = byPart[part].sort((a, b) => a.time - b.time);
    for (let i = 0; i < list.length; i++) {
      const a = list[i], b = list[i + 1];
      out.push({ time: a.time, part: a.part, props: Object.assign({}, a.props) });
      const ez = segmentEase(a, b);
      if (!b || !ez || !ez.ease || ez.ease === 'linear') continue;
      if (part === 'effect' || part.startsWith('effect')) continue;   // 特效帧是触发点，不能烘焙
      const shared = [];
      const all = new Set(Object.keys(a.props || {}).concat(Object.keys(b.props || {})));
      all.forEach(k => {
        if (k === 'frame' || k === 'name') return;
        if (typeof a.props[k] === 'number' && typeof b.props[k] === 'number') shared.push(k);
      });
      if (!shared.length) continue;
      const dur = b.time - a.time;
      if (!(dur > 0.0005)) continue;
      // 从段首开始，每隔 step 秒插入一个采样点；最后不足一步的差值由终点帧补上
      for (let s = 1; s < 10001; s++) {
        const t = Math.round((a.time + s * step) * 1000) / 1000;
        if (t >= b.time - 0.0005) break;
        const u = (t - a.time) / dur;
        const p = easeValue(u, ez);
        const props = {};
        shared.forEach(k => { props[k] = a.props[k] + (b.props[k] - a.props[k]) * p; });
        out.push({ time: t, part: a.part, props: props });
      }
    }
  }
  out.sort((a, b) => a.time - b.time || partOrder(a.part) - partOrder(b.part));
  // 时间四舍五入到毫秒后可能出现同名键；保留后出现的（源帧 / 终点帧优先）
  const seen = {};
  const uniq = [];
  out.forEach(k => {
    const id = k.part + '|' + fmtTime(k.time);
    if (seen[id] !== undefined) uniq[seen[id]] = k;
    else { seen[id] = uniq.length; uniq.push(k); }
  });
  return uniq.sort((a, b) => a.time - b.time || partOrder(a.part) - partOrder(b.part));
}

function normalizeBakeStep(v) {
  let n = parseFloat(v);
  if (!isFinite(n) || n <= 0) n = 0.05;
  return Math.max(0.005, Math.min(2, Math.round(n * 1000) / 1000));
}
function loadBakeStepPref() {
  try {
    const v = localStorage.getItem('rt_bake_step');
    if (v != null) return normalizeBakeStep(v);
  } catch (e) { /* 本地存储不可用 */ }
  return 0.05;
}
function saveBakeStepPref() {
  try { localStorage.setItem('rt_bake_step', String(STUDIO.bakeStep)); } catch (e) { /* 忽略 */ }
}
function normalizeGrid(v) {
  let n = parseFloat(v);
  if (!isFinite(n) || n <= 0) n = 5;
  return Math.max(0.1, Math.min(200, Math.round(n * 10) / 10));
}
function loadGridPref() {
  try {
    const v = localStorage.getItem('rt_anim_grid');
    if (v != null) return normalizeGrid(v);
  } catch (e) { /* 忽略 */ }
  return 5;
}
function saveGridPref() {
  try { localStorage.setItem('rt_anim_grid', String(STUDIO.grid)); } catch (e) { /* 忽略 */ }
}

/** 生成 [animation_x] 段的条目（顺序按代码表） */
function studioEntries(useBake) {
  const P = STUDIO.params;
  const out = [];
  const push = (k, v) => { if (v !== '' && v !== undefined && v !== null) out.push({ key: k, value: String(v) }); };
  push('onActions', P.onActions);
  push('onActionsQueuedUnitPlayAt', P.onActionsQueuedUnitPlayAt);
  push('blendIn', P.blendIn);
  push('blendOut', P.blendOut);
  push('pingPong', P.pingPong);
  push('playbackRate', P.playbackRate);
  push('KeyframeTimeScale', P.KeyframeTimeScale);
  push('direction_units', P.direction_units);
  push('direction_strideX', P.direction_strideX);
  push('direction_strideY', P.direction_strideY);
  push('direction_starting', P.direction_starting);
  push('start', P.start);
  push('end', P.end);
  push('scale_start', P.scale_start);
  push('scale_end', P.scale_end);
  push('speed', P.speed);
  const bake = useBake !== false && STUDIO.bake;
  const keys = (bake ? bakeAnimKeys(STUDIO.keys) : STUDIO.keys.slice())
    .sort((a, b) => a.time - b.time || partOrder(a.part) - partOrder(b.part));
  for (const k of keys) out.push({ key: k.part + '_' + fmtTime(k.time), value: fmtProps(k.props) });
  return out;
}

/* ---------------- 采样（时间 → 各部件状态） ---------------- */
function scaleFactor() {
  const s = parseFloat(STUDIO.params.KeyframeTimeScale);
  return (isFinite(s) && s > 0) ? s : 1;
}
function animDuration() {
  let mx = 0;
  for (const k of STUDIO.keys) mx = Math.max(mx, k.time);
  return Math.max(0.1, mx * scaleFactor());
}
function timeScaleOf(params) {
  const v = parseFloat((params || {}).KeyframeTimeScale);
  return (isFinite(v) && v > 0) ? v : 1;
}
/** 从给定关键帧表里采样（不依赖全局 STUDIO） */
function samplePartFrom(keys, scale, part, tSec) {
  const list = (keys || []).filter(k => k.part === part).sort((a, b) => a.time - b.time);
  if (!list.length) return null;
  const at = k => k.time * (scale || 1);
  if (tSec <= at(list[0])) return Object.assign({}, list[0].props);
  const lastK = list[list.length - 1];
  if (tSec >= at(lastK)) return Object.assign({}, lastK.props);
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    const ta = at(a), tb = at(b);
    if (tSec >= ta && tSec <= tb) {
      const r = tb > ta ? (tSec - ta) / (tb - ta) : 0;
      const e = easeValue(r, segmentEase(a, b));
      const out = {};
      const keys = new Set(Object.keys(a.props).concat(Object.keys(b.props)));
      keys.forEach(k => {
        const va = a.props[k], vb = k in b.props ? b.props[k] : va;
        if (k === 'frame' || k === 'name') {
          out[k] = (r < 1 ? va : vb);             // 帧 / 特效名是离散值，不能插值
        } else if (typeof va === 'number' && typeof vb === 'number') {
          out[k] = va + (vb - va) * e;
        } else {
          out[k] = (r < 1 ? va : vb);
        }
      });
      return out;
    }
  }
  return Object.assign({}, lastK.props);
}
function samplePart(part, tSec) {
  return samplePartFrom(STUDIO.keys, scaleFactor(), part, tSec);
}

/* ---------------- 文档里的可动画部件 ---------------- */
function studioParts(keys) {
  keys = keys || STUDIO.keys;
  const parts = [{ id: 'body', kind: 'body', label: '主体' }];
  const seen = {};
  const addSec = (kind, idx, kv, label) => {
    const key = kind + (idx === '' ? '' : idx);
    if (seen[key]) return;
    seen[key] = 1;
    parts.push({ id: key, kind: kind, idx: idx, label: label || key, kv: kv || {} });
  };
  for (const s of S.doc.sections) {
    const id = deriveSecId(s.name);
    const nm = String(s.name).replace(/^\[|\]$/g, '');
    const kv = {};
    for (const e of s.entries) if (e.key) kv[e.key] = e.value;
    let m;
    // 炮塔 / 腿 / 胳膊用序号（turret1_5s、leg1_5s、arm1_5s）
    if (id === 'turret' && (m = nm.match(/_(\d+)$/))) addSec('turret', m[1], kv, '炮塔' + m[1]);
    else if (id === 'leg_#' && (m = nm.match(/_(\d+)$/)))
      addSec(/^arm/i.test(nm) ? 'arm' : 'leg', m[1], kv, (/^arm/i.test(nm) ? '胳膊' : '腿') + m[1]);
  }
  // 特效：RW 里是按名字引用的（effect_2s: {name: explode}），所以只有一个“特效”部件
  addSec('effect', '', {}, '特效');
  // 关键帧里出现、但文档里没有对应段的部件也要能显示（含 effect / 手写的 turret3 等）
  for (const k of keys) {
    const kind = k.part.replace(/\d+$/, '');
    const idx = (k.part.match(/(\d+)$/) || [])[1] || '';
    if (kind === 'body') continue;
    addSec(kind, idx, {}, ({ turret: '炮塔', leg: '腿', arm: '胳膊', effect: '特效' })[kind] + (idx || ''));
  }
  return parts;
}

/** 制作器专用：文档/部位没变时复用部件列表，避免 60fps 每帧扫描 70+ 个段 */
function studioCachedParts() {
  const ids = [];
  for (const k of STUDIO.keys) if (ids.indexOf(k.part) < 0) ids.push(k.part);
  const sig = (S.doc.rev || 0) + '|' + ids.sort().join(',');
  if (STUDIO._partsSig !== sig || !STUDIO._parts) {
    STUDIO._parts = studioParts(STUDIO.keys);
    STUDIO._partsSig = sig;
  }
  return STUDIO._parts;
}

/** 文档里能用的特效名（给 effect 关键帧的 name 下拉用） */
function docEffectNames() {
  const out = [];
  for (const s of S.doc.sections) {
    if (deriveSecId(s.name) !== 'effect') continue;
    const nm = String(s.name).replace(/^\[|\]$/g, '').replace(/^effect_/i, '');
    if (out.indexOf(nm) < 0) out.push(nm);
  }
  return out;
}

/* ---------------- 预览绘制 ---------------- */
const ANIM_SPRITE_CACHE = {};
function animSprite(ref) {
  if (!ref || /^(NONE|AUTO)$/i.test(String(ref).trim())) return null;
  const sp = spriteOf(ref);
  return sp && sp.kind === 'file' ? sp : { kind: sp ? sp.kind : 'loading' };
}

/** 当前选中部位用到的贴图信息（制作器预览 + 左上角贴图卡） */
function studioPartVisual(partId) {
  const parts = studioCachedParts();
  const part = parts.find(p => p.id === partId) || { id: 'body', kind: 'body', label: '主体' };
  const kv = part.kv || {};
  const g = firstSecMap('graphics');
  let ref = '', frames = 1, fw = 0, fh = 0, label = part.label, note = '';
  if (part.kind === 'body') {
    ref = g.image; frames = Math.max(1, num(g.total_frames, 1));
    fw = num(g.frame_width, 0); fh = num(g.frame_height, 0);
  } else if (part.kind === 'turret') {
    ref = kv.image || g.image_turret;
    frames = Math.max(1, num(kv.total_frames, 1));
    fw = num(kv.frame_width, 0); fh = num(kv.frame_height, 0);
  } else if (part.kind === 'leg' || part.kind === 'arm') {
    ref = kv.image_leg || kv.image_middle || kv.image_foot || kv.image_end;
    frames = Math.max(1, num(kv.total_frames, 1));
    fw = num(kv.frame_width, 0); fh = num(kv.frame_height, 0);
  } else if (part.kind === 'effect') {
    let want = '';
    if (STUDIO.selKey && STUDIO.selKey.part === part.id) want = String((STUDIO.selKey.props || {}).name || '').trim();
    if (!want) {
      const ns = $('#stProps [data-prop="name"]');
      if (ns && ns.value) want = String(ns.value).trim();
    }
    if (!want) {
      const k = STUDIO.keys.find(x => x.part === part.id && x.props && x.props.name);
      if (k) want = String(k.props.name).trim();
    }
    label = want ? '特效 ' + want : '特效';
    if (!want) note = '未指定特效 name';
    else {
      let sec = null;
      for (const ss of S.doc.sections) {
        if (deriveSecId(ss.name) !== 'effect') continue;
        const nm = String(ss.name).replace(/^\[|\]$/g, '').replace(/^effect_/i, '');
        if (nm === want) { sec = ss; break; }
      }
      if (!sec) note = '本文件没有 [effect_' + want + ']';
      else {
        const ekv = {};
        for (const e of sec.entries) if (e.key) ekv[e.key] = e.value;
        ref = ekv.image;
        frames = Math.max(1, num(ekv.total_frames, 1));
        fw = num(ekv.frame_width, 0); fh = num(ekv.frame_height, 0);
      }
    }
  }
  ref = String(ref == null ? '' : ref).trim();
  if (/^(NONE|AUTO)$/i.test(ref)) ref = '';
  if (!ref && !note) note = part.kind === 'effect' ? '未设置特效贴图' : '未设置贴图';
  return { part, ref, frames, fw, fh, label, note };
}

/** 左上角当前部位贴图卡：选中哪个部位就显示哪个部位的贴图 */
function studioRefreshPartPreview() {
  const cv = $('#stPartThumb');
  if (!cv) return;
  const studio = $('#studio');
  if (studio && studio.classList.contains('hidden')) return;
  const partId = STUDIO.selKey ? STUDIO.selKey.part : (($('#stPart') || {}).value || 'body');
  const vis = studioPartVisual(partId);
  const lab = $('#stPartLabel'), info = $('#stPartInfo');
  if (lab) lab.textContent = vis.label;
  if (info) {
    let meta = vis.ref || vis.note || '未设置贴图';
    if (vis.ref && vis.frames > 1) meta += ' · ' + vis.frames + ' 帧';
    info.textContent = meta;
    info.title = meta;
  }
  const ctx = pixelCtx(cv);
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b1016'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(62,200,255,.10)'; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 11) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 11) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const sp = vis.ref ? animSprite(vis.ref) : null;
  if (sp && sp.kind === 'file' && sp.state === 'ok' && sp.img) {
    const im = sp.img;
    let fw = vis.fw > 0 ? vis.fw : 0, fh = vis.fh > 0 ? vis.fh : 0;
    if (vis.frames > 1 && fw <= 0 && im.width >= vis.frames) {
      fw = Math.floor(im.width / vis.frames); fh = im.height;
    }
    const sw = fw > 0 ? fw : im.width, sh = fh > 0 ? fh : im.height;
    const scale = Math.min((W - 6) / Math.max(1, sw), (H - 6) / Math.max(1, sh));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(im, 0, 0, sw, sh, (W - sw * scale) / 2, (H - sh * scale) / 2, sw * scale, sh * scale);
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(4.5, 4.5, W - 9, H - 9);
    ctx.setLineDash([]);
    ctx.fillStyle = '#8a97aa';
    ctx.font = '10px "Microsoft YaHei UI"';
    ctx.textAlign = 'center';
    ctx.fillText(vis.ref ? '读取中…' : '无贴图', W / 2, H / 2 + 3);
    ctx.textAlign = 'left';
  }
}

/** 把一个部件的贴图（或占位块）画出来 */
function drawPart(ctx, part, props, cx, cy, scale, tMs) {
  const kv = part.kv || {};
  let img = null, frames = 1, fw = 0, fh = 0, label = part.label;
  if (part.kind === 'body') {
    const g = firstSecMap('graphics');
    img = animSprite(g.image);
    frames = Math.max(1, num(g.total_frames, 1));
    fw = num(g.frame_width, 0); fh = num(g.frame_height, 0);
  } else if (part.kind === 'turret') {
    img = animSprite(kv.image) || animSprite(firstSecMap('graphics').image_turret);
    frames = Math.max(1, num(kv.total_frames, 1));
  } else if (part.kind === 'leg' || part.kind === 'arm') {
    img = animSprite(kv.image_leg) || animSprite(kv.image_middle) || animSprite(kv.image_foot) || animSprite(kv.image_end);
    frames = Math.max(1, num(kv.total_frames, 1));
  } else if (part.kind === 'effect') {
    // 特效关键帧用 name 指定特效名：name: explode → [effect_explode] 的贴图
    const want = String(props.name || '').trim();
    let sec = null;
    for (const ss of S.doc.sections) {
      if (deriveSecId(ss.name) !== 'effect') continue;
      const nm = String(ss.name).replace(/^\[|\]$/g, '').replace(/^effect_/i, '');
      if (nm === want) { sec = ss; break; }
    }
    const ekv = {};
    if (sec) for (const e of sec.entries) if (e.key) ekv[e.key] = e.value;
    img = animSprite(ekv.image);
    frames = Math.max(1, num(ekv.total_frames, 1));
    fw = num(ekv.frame_width, 0); fh = num(ekv.frame_height, 0);
    label = want ? ('特效 ' + want) : '特效（未指定 name）';
  }
  const ox = num(kv.x, 0), oy = num(kv.y, 0);            // 部件自身的安装位置
  const ax = num(kv.attach_x, num(kv.barrelX, 0)), ay = num(kv.attach_y, num(kv.barrelY, 0));
  const px = cx + (ox + ax + num(props.x, 0)) * scale;
  const py = cy - (oy + ay + num(props.y, 0)) * scale;
  const sc = num(props.scale, 1) * 1;
  const alpha = props.alpha !== undefined ? Math.max(0, Math.min(1, num(props.alpha, 1))) : 1;
  const frame = props.frame !== undefined ? Math.max(0, Math.round(num(props.frame, 0))) : 0;

  ctx.save();
  ctx.globalAlpha = alpha;
  const w = 22 * scale, h = 22 * scale;
  let retW = w, retH = h;
  if (img && img.state === 'ok' && img.img && img.img.width) {
    const im = img.img;
    let effFw = fw, effFh = fh;
    if (frames > 1 && effFw <= 0 && im.width % frames === 0) {
      effFw = Math.floor(im.width / frames);       // 等宽排列的贴图条，自动算单帧宽度
      effFh = im.height;
    }
    let sw = effFw > 0 ? effFw : im.width, sh = effFh > 0 ? effFh : im.height, sx = 0, sy = 0;
    if (frames > 1 && sw > 0 && sh > 0 && im.width >= sw) {
      const perRow = Math.max(1, Math.floor(im.width / sw));
      const idx = frame % frames;
      sx = (idx % perRow) * sw;
      sy = Math.floor(idx / perRow) * sh;
    }
    const dw = sw * scale * sc, dh = sh * scale * sc;
    retW = dw; retH = dh;
    ctx.imageSmoothingEnabled = false;
    // dir：手臂/腿脚绕安装点旋转（RW 里 dir 是角度）
    const dir = props.dir !== undefined ? num(props.dir, 0) : 0;
    if (dir) {
      ctx.translate(px, py);
      ctx.rotate(dir * Math.PI / 180);
      ctx.drawImage(im, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
      ctx.setTransform(1, 0, 0, 1, 0, 0);      // drawAnimFrame 每帧会重设，这里恢复即可
    } else {
      ctx.drawImage(im, sx, sy, sw, sh, px - dw / 2, py - dh / 2, dw, dh);
    }
  } else {
    // 找不到贴图就画个方块占位，动画照样能看出来
    const col = part.kind === 'body' ? '#2b6cb0' : part.kind === 'turret' ? '#c53030'
      : part.kind === 'effect' ? '#805ad5' : '#2f855a';
    ctx.fillStyle = col + 'cc';
    ctx.strokeStyle = '#ffffff55';
    ctx.beginPath();
    const bw = w * sc, bh = h * sc;
    retW = bw; retH = bh;
    ctx.rect(px - bw / 2, py - bh / 2, bw, bh);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#e6edf6';
    ctx.font = '10px "Microsoft YaHei UI"';
    ctx.fillText(label, px - bw / 2, py - bh / 2 - 3);
  }
  ctx.restore();
  return { px: px, py: py, w: retW, h: retH };
}

/** 在预览上圈出当前选中的部位 */
function drawPartHighlight(ctx, box) {
  if (!box || !box.w || !box.h) return;
  const x = box.x - box.w / 2 - 4, y = box.y - box.h / 2 - 4;
  const w = box.w + 8, h = box.h + 8;
  ctx.save();
  // 用两层描边代替 shadowBlur：大贴图每帧重绘时阴影模糊很吃性能
  ctx.strokeStyle = 'rgba(255,214,10,.20)';
  ctx.lineWidth = 7;
  ctx.strokeRect(x, y, w, h);
  ctx.strokeStyle = '#ffd60a';
  ctx.lineWidth = 2.4;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  const label = box.label || '选中部位';
  ctx.font = 'bold 11px "Microsoft YaHei UI"';
  const tw = ctx.measureText(label).width;
  const ly = y > 26 ? y - 8 : y + 20;
  ctx.fillStyle = 'rgba(8,12,18,.82)';
  ctx.fillRect(x + 4, ly - 13, tw + 10, 17);
  ctx.fillStyle = '#ffd60a';
  ctx.fillText(label, x + 9, ly);
  ctx.restore();
}

/** 2D 制作器的选中部件 XY 轴手柄 */
function drawPartHandles(ctx, box, W, H) {
  const cx = box.x, cy = box.y, L = 48;
  const x0 = Math.max(2, cx - L), x1 = Math.min(W - 2, cx + L);
  const y0 = Math.max(2, cy - L), y1 = Math.min(H - 2, cy + L);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#ff9f0a';
  ctx.fillStyle = '#ff9f0a';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x0, cy); ctx.lineTo(x1, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x1 - 7, cy - 5); ctx.lineTo(x1, cy); ctx.lineTo(x1 - 7, cy + 5); ctx.stroke();
  ctx.beginPath(); ctx.arc(x1, cy, 4, 0, Math.PI * 2); ctx.fill();
  ctx.font = 'bold 10px "Microsoft YaHei UI"';
  ctx.fillText('X', Math.min(W - 12, x1 + 6), cy + 4);
  ctx.strokeStyle = '#30d158';
  ctx.fillStyle = '#30d158';
  ctx.beginPath(); ctx.moveTo(cx, y1); ctx.lineTo(cx, y0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - 5, y0 + 7); ctx.lineTo(cx, y0); ctx.lineTo(cx + 5, y0 + 7); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, y0, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillText('Y', cx + 6, Math.max(12, y0 - 4));
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = 'rgba(8,12,18,.75)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#ffd60a';
  ctx.beginPath(); ctx.arc(cx, cy, 2.2, 0, Math.PI * 2); ctx.fill();
  if (box.canRotate) {
    const R = Math.max(42, Math.min(76, Math.max(box.w || 22, box.h || 22) / 2 + 18));
    ctx.strokeStyle = 'rgba(94,92,230,.45)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    const a = ((Number(box.dir) || 0) - 45) * Math.PI / 180;
    const hx = cx + Math.cos(a) * R, hy = cy + Math.sin(a) * R;
    ctx.fillStyle = '#5e5ce6';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(hx, hy, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px "Microsoft YaHei UI"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('↻', hx, hy - 0.5);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

/** 画一帧动画（供制作器和效果预览共用）
 *  keys/scale 由调用方传入，绝不读写全局 STUDIO —— 否则效果预览的小卡片会和制作器互相覆盖 */
function drawAnimFrame(ctx, W, H, keys, kScale, tSec, opt) {
  opt = opt || {};
  ctx.imageSmoothingEnabled = false;
  const parts = opt.parts || studioParts(keys);
  const pad = 26;
  const scale = opt.scale || 1;
  const cx = W / 2, cy = H / 2;
  // 背景 + 网格
  ctx.fillStyle = '#0b1016'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(62,200,255,.10)'; ctx.lineWidth = 1;
  for (let x = cx % 20; x < W; x += 20) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = cy % 20; y < H; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(255,255,255,.22)';
  ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy);
  ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8); ctx.stroke();

  const viewZoom = opt.zoom || 1;
  const viewPanX = opt.panX || 0, viewPanY = opt.panY || 0;
  ctx.save();
  if (viewZoom !== 1 || viewPanX || viewPanY) {
    ctx.translate(cx + viewPanX, cy + viewPanY);
    ctx.scale(viewZoom, viewZoom);
    ctx.translate(-cx, -cy);
  }
  const byKind = {};
  for (const p of parts) (byKind[p.kind] = byKind[p.kind] || []).push(p);
  const readout = [];
  let hlBox = null;
  const drawOne = part => {
    let props = part.kind === 'body' ? (samplePartFrom(keys, kScale, 'body', tSec) || {})
                                     : (samplePartFrom(keys, kScale, part.id, tSec) || {});
    const selected = opt.highlightPart && part.id === opt.highlightPart;
    if (selected && part.kind === 'effect' && !Object.keys(props).length && opt.selectedEffectName) {
      props = { name: opt.selectedEffectName };
    }
    const hasProps = Object.keys(props).length > 0;
    // 没有关键帧的部件不占地方；但当前选中的部位要画出来，方便看贴图和位置
    if (part.kind !== 'body' && !hasProps && !selected) return;
    const pos = drawPart(ctx, part, props, cx, cy, scale, opt.tMs || 0);
    const canRotate = part.kind === 'arm' || part.kind === 'leg';
    const dir = Number(props.dir) || 0;
    if (opt.positions && pos) opt.positions[part.id] = Object.assign({}, pos, { kind: part.kind, canRotate, dir });
    if (selected && pos && pos.w > 0 && pos.h > 0) {
      const hlLabel = (part.kind === 'effect' && props.name) ? ('特效 ' + props.name) : part.label;
      hlBox = { x: pos.px, y: pos.py, w: pos.w, h: pos.h, label: hlLabel, kind: part.kind, canRotate, dir };
    }
    if (hasProps) readout.push(part.label + ' ' + fmtProps(props));
    else if (selected) readout.push(part.label + '（未设关键帧，静态显示）');
  };
  // drawOverBody：炮塔默认 true（画在主体之上）；false 的先于主体绘制
  const turretUnder = [], turretOver = [];
  for (const p of (byKind.turret || [])) {
    const kv = p.kv || {};
    const over = !/^false$/i.test(String(kv.drawOverBody == null ? 'true' : kv.drawOverBody));
    (over ? turretOver : turretUnder).push(p);
  }
  for (const part of (byKind.leg || [])) drawOne(part);
  for (const part of (byKind.arm || [])) drawOne(part);
  for (const p of turretUnder) drawOne(p);
  drawOne({ id: 'body', kind: 'body', label: '主体' });
  for (const p of turretOver) drawOne(p);
  for (const part of (byKind.effect || [])) drawOne(part);
  if (hlBox) drawPartHighlight(ctx, hlBox);
  if (hlBox && opt.showHandles && hlBox.kind !== 'body') drawPartHandles(ctx, hlBox, W, H);
  ctx.restore();
  // 时间标注
  ctx.fillStyle = '#6b7d94'; ctx.font = '11px monospace';
  ctx.fillText('t = ' + tSec.toFixed(2) + 's', 8, H - 8);
  if (opt.showReadout !== false) {
    ctx.fillStyle = '#9fb0c6'; ctx.font = '11px "Microsoft YaHei UI"';
    readout.slice(0, 4).forEach((r, i) => ctx.fillText(r, W - 210, 16 + i * 14));
  }
  return readout;
}

/* ---------------- 制作器界面 ---------------- */
function openStudio(loadName) {
  STUDIO._sizeDirty = true;
  STUDIO._phSizeDirty = true;
  STUDIO._phFirst = true;
  if (!document.querySelector('#studio')) buildStudioDom();
  if (loadName) {
    const sec = S.doc.sections.find(s => s.name === loadName);
    if (sec) loadStudioFromSection(sec);
  } else {
    const first = S.doc.sections.find(s => deriveSecId(s.name) === 'animation');
    if (first) loadStudioFromSection(first);
    else { STUDIO.keys = []; STUDIO.params = defaultParams(); STUDIO.name = suggestAnimName(); }
  }
  STUDIO.formOpen = !STUDIO.keys.length;
  $('#studio').classList.remove('hidden');
  const box = $('#studioBox');
  if (box) box.classList.remove('hidden');
  if (!STUDIO._tlInit) { STUDIO._tlInit = true; STUDIO.tlCollapsed = window.innerWidth < 760; }
  STUDIO.stTab = 'keys';
  STUDIO.zoom = 1; STUDIO.panX = 0; STUDIO.panY = 0;
  studioRefreshAll();
  studioUpdateViewUI();
  studioHistoryReset();
  studioPlay(true);
}

function closeStudio() {
  const el = $('#studio');
  if (el) el.classList.add('hidden');
  studioPlay(false);
  // 制作器期间暂缓的效果预览，关闭后补一次
  if (typeof renderEffect === 'function' && $('#tabEffect') &&
      !$('#tabEffect').classList.contains('hidden')) {
    try { renderEffect(); } catch (e) { /* 忽略预览重绘错误 */ }
  }
}
function defaultParams() {
  return { onActions: 'idle', onActionsQueuedUnitPlayAt: '', blendIn: '0.5s', blendOut: '0.5s',
    KeyframeTimeScale: '', pingPong: 'false', playbackRate: '', direction_units: '',
    direction_strideX: '', direction_strideY: '', direction_starting: '',
    start: '', end: '', scale_start: '', scale_end: '', speed: '' };
}
function suggestAnimName() {
  const used = S.doc.sections.map(s => String(s.name));
  let i = 2;
  while (used.indexOf('animation_' + i) >= 0) i++;
  return 'animation_' + i;
}

function studioSecSig(sec) {
  return (sec.entries || []).map(e => e.key + '=' + e.value).join('\n');
}
function studioSrcStoreKey(name) {
  return 'rt_anim_src::' + encodeURIComponent(S.doc.path || '') + '::' + encodeURIComponent(name);
}
function updateStudioSrcHint() {
  const el = $('#stSrcHint');
  if (!el) return;
  el.textContent = STUDIO._srcRestored ? '缓动源：本机缓存' : '';
}
function saveStudioSource(sec) {
  try {
    if (!sec) return;
    const snap = {
      v: 1, name: sec.name, sig: studioSecSig(sec), step: STUDIO.bakeStep, bake: !!STUDIO.bake,
      keys: JSON.parse(JSON.stringify(STUDIO.keys)), at: Date.now(),
    };
    localStorage.setItem(studioSrcStoreKey(sec.name), JSON.stringify(snap));
    STUDIO._srcRestored = true;
    updateStudioSrcHint();
  } catch (e) { /* 本地存储不可用时静默忽略 */ }
}
function restoreStudioSource(sec) {
  STUDIO._srcRestored = false;
  updateStudioSrcHint();
  try {
    if (!sec) return false;
    const raw = localStorage.getItem(studioSrcStoreKey(sec.name));
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || snap.sig !== studioSecSig(sec) || !Array.isArray(snap.keys) || !snap.keys.length) return false;
    const keys = snap.keys.filter(k => k && k.part && isFinite(k.time) && k.props && typeof k.props === 'object')
      .map(k => ({
        time: Number(k.time), part: String(k.part), props: Object.assign({}, k.props),
        ease: k.ease || 'linear', bezier: Array.isArray(k.bezier) ? k.bezier.slice() : undefined,
      }));
    if (!keys.length) return false;
    STUDIO.keys = keys;
    if (isFinite(Number(snap.step))) STUDIO.bakeStep = normalizeBakeStep(snap.step);
    if (typeof snap.bake === 'boolean') STUDIO.bake = snap.bake;
    if ($('#stBakeStep')) $('#stBakeStep').value = STUDIO.bakeStep;
    STUDIO._srcRestored = true;
    updateStudioSrcHint();
    return true;
  } catch (e) { updateStudioSrcHint(); return false; }
}

function loadStudioFromSection(sec) {
  const p = parseAnimSection(sec);
  STUDIO.name = String(sec.name);
  STUDIO.params = Object.assign(defaultParams(), p.params);
  STUDIO.keys = p.keys;
  restoreStudioSource(sec);
  STUDIO.t = 0;
  STUDIO.selKey = null;
  STUDIO.formOpen = !p.keys.length;
  if ($('#stDur')) $('#stDur').value = '';
}
function loadStudioFromEntries(name, entries) {
  const fake = { name: name, entries: entries.map(e => newEntry(e.key, e.value)) };
  loadStudioFromSection(fake);
}

/* ---------- 2D 画布：选中部件 / XY 轴拖动 ---------- */
function studioCanvasRawPoint(ev) {
  const cv = $('#stCanvas');
  if (!cv || !STUDIO._drawW) return null;
  const r = cv.getBoundingClientRect();
  const sx = STUDIO._drawW / Math.max(1, cv.clientWidth);
  const sy = STUDIO._drawH / Math.max(1, cv.clientHeight);
  return { x: (ev.clientX - r.left - cv.clientLeft) * sx,
           y: (ev.clientY - r.top - cv.clientTop) * sy };
}
function studioCanvasPoint(ev) {
  const raw = studioCanvasRawPoint(ev);
  if (!raw) return null;
  const z = STUDIO.zoom || 1;
  const cx = STUDIO._drawW / 2, cy = STUDIO._drawH / 2;
  return { x: cx + (raw.x - cx - (STUDIO.panX || 0)) / z,
           y: cy + (raw.y - cy - (STUDIO.panY || 0)) / z };
}
function studioSetZoom(z, raw) {
  const cx = (STUDIO._drawW || 1) / 2, cy = (STUDIO._drawH || 1) / 2;
  const anchor = raw || { x: cx, y: cy };
  const old = STUDIO.zoom || 1;
  const wx = cx + (anchor.x - cx - (STUDIO.panX || 0)) / old;
  const wy = cy + (anchor.y - cy - (STUDIO.panY || 0)) / old;
  const nz = Math.max(0.2, Math.min(8, z));
  STUDIO.zoom = Math.round(nz * 100) / 100;
  STUDIO.panX = anchor.x - cx - (wx - cx) * STUDIO.zoom;
  STUDIO.panY = anchor.y - cy - (wy - cy) * STUDIO.zoom;
  studioDrawOnly();
  studioUpdateViewUI();
}
function studioUpdateViewUI() {
  const v = $('#stViewZoomVal');
  if (v) v.textContent = Math.round((STUDIO.zoom || 1) * 100) + '%';
}
function studioRecenterView() {
  STUDIO.panX = 0;
  STUDIO.panY = 0;
  studioDrawOnly();
}
function studioResetView() {
  STUDIO.zoom = 1;
  STUDIO.panX = 0;
  STUDIO.panY = 0;
  studioDrawOnly();
  studioUpdateViewUI();
}
function studioSelectedPartId() {
  return STUDIO.selKey ? STUDIO.selKey.part : (($('#stPart') || {}).value || 'body');
}
function studioHitHandle(pt, pos) {
  if (!pos) return null;
  const dx = pt.x - pos.px, dy = pt.y - pos.py;
  if (pos.canRotate) {
    const R = Math.max(42, Math.min(76, Math.max(pos.w || 22, pos.h || 22) / 2 + 18));
    const a = ((Number(pos.dir) || 0) - 45) * Math.PI / 180;
    const hx = pos.px + Math.cos(a) * R, hy = pos.py + Math.sin(a) * R;
    if (Math.hypot(pt.x - hx, pt.y - hy) <= 14) return 'rotate';
  }
  if (Math.hypot(dx, dy) <= 12) return 'both';
  if (Math.abs(dy) <= 9 && Math.abs(dx) <= 58) return 'x';
  if (Math.abs(dx) <= 9 && Math.abs(dy) <= 58) return 'y';
  return null;
}
function studioHitPart(pt) {
  let best = null, bestArea = Infinity;
  for (const id in (STUDIO._positions || {})) {
    const p = STUDIO._positions[id];
    if (!p || !p.w || !p.h) continue;
    if (pt.x >= p.px - p.w / 2 && pt.x <= p.px + p.w / 2 &&
        pt.y >= p.py - p.h / 2 && pt.y <= p.py + p.h / 2) {
      const area = p.w * p.h;
      if (id !== 'body' && area < bestArea) { best = id; bestArea = area; }
      else if (!best) { best = id; bestArea = area; }
    }
  }
  return best;
}
function studioSelectCanvasPart(partId) {
  const sel = $('#stPart');
  if (!sel || !partId) return;
  studioPlay(false);
  STUDIO.formOpen = true;
  studioApplyFormState();
  sel.value = partId;
  const raw = Math.round(STUDIO.t / Math.max(0.001, scaleFactor()) * 1000) / 1000;
  const k = STUDIO.keys.find(x => x.part === partId && Math.abs(x.time - raw) < 0.0001);
  STUDIO.selKey = k || null;
  studioRefreshProps();
  if (k) studioFillFormFromKey(k);
  else {
    const sample = samplePartFrom(STUDIO.keys, scaleFactor(), partId, STUDIO.t) || {};
    if ($('#stKTime')) $('#stKTime').value = raw;
    $$('#stProps [data-prop]').forEach(inp => {
      const v = sample[inp.dataset.prop];
      inp.value = v !== undefined ? v : '';
    });
  }
  studioSyncTimelineSelection();
  studioRenderTimeline();
  studioSetTab('keys');
  studioDrawOnly();
  studioRefreshPartPreview();
}
function studioEnsureKeyAt(partId, raw) {
  let k = STUDIO.keys.find(x => x.part === partId && Math.abs(x.time - raw) < 0.0001);
  if (!k) {
    const sample = samplePartFrom(STUDIO.keys, scaleFactor(), partId, STUDIO.t) || {};
    k = { time: raw, part: partId, props: Object.assign({}, sample), ease: 'linear' };
    STUDIO.keys.push(k);
    STUDIO.keys.sort((a, b) => a.time - b.time || partOrder(a.part) - partOrder(b.part));
  }
  if (!isFinite(Number(k.props.x))) k.props.x = 0;
  if (!isFinite(Number(k.props.y))) k.props.y = 0;
  return k;
}
function studioBeginPartDrag(ev, partId, mode) {
  const part = studioCachedParts().find(p => p.id === partId);
  if (!part || part.kind === 'body') return;
  ev.preventDefault();
  studioPlay(false);
  const raw = Math.round(STUDIO.t / Math.max(0.001, scaleFactor()) * 1000) / 1000;
  const key = studioEnsureKeyAt(partId, raw);
  STUDIO.selKey = key;
  STUDIO.formOpen = true;
  studioApplyFormState();
  studioSetTab('keys');
  const sel = $('#stPart');
  if (sel) sel.value = partId;
  studioFillFormFromKey(key);
  const center = (STUDIO._positions || {})[partId] || {};
  const startPt = studioCanvasPoint(ev) || { x: 0, y: 0 };
  const a0 = Math.atan2(startPt.y - (center.py || 0), startPt.x - (center.px || 0));
  const d0 = Number(key.props.dir) || 0;
  const x0 = Number(key.props.x) || 0, y0 = Number(key.props.y) || 0;
  STUDIO.dragging = true;
  STUDIO._dragState = { partId, mode };
  let moved = false;
  const xi = $('#stProps [data-prop="x"]'), yi = $('#stProps [data-prop="y"]');
  const di = $('#stProps [data-prop="dir"]');
  const grid = () => normalizeGrid(STUDIO.grid);
  const snap = (v, on) => on ? Math.round(v / grid()) * grid() : v;
  const move = e => {
    const pt0 = studioCanvasPoint(e) || startPt;
    const dx = pt0.x - startPt.x, dy = pt0.y - startPt.y;
    if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
    const ctrl = !!(e.ctrlKey || e.metaKey);
    if (mode === 'rotate') {
      const pt = studioCanvasPoint(e) || { x: 0, y: 0 };
      const ang = Math.atan2(pt.y - (center.py || 0), pt.x - (center.px || 0));
      let nd = d0 + (ang - a0) * 180 / Math.PI;
      if (ctrl) nd = Math.round(nd / grid()) * grid();
      nd = Math.round(nd * 1000) / 1000;
      key.props.dir = nd;
      if (di) di.value = nd;
    } else {
      if (mode !== 'y') {
        key.props.x = Math.round(snap(x0 + dx, ctrl) * 1000) / 1000;
        if (xi) xi.value = key.props.x;
      }
      if (mode !== 'x') {
        key.props.y = Math.round(snap(y0 - dy, ctrl) * 1000) / 1000;
        if (yi) yi.value = key.props.y;
      }
    }
    studioRequestDraw();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    STUDIO._dragState = null;
    STUDIO.dragging = false;
    studioRefreshAll();
    if (typeof studioRenderCodeView === 'function') studioRenderCodeView();
    if (moved) {
      if (mode === 'rotate') toast('旋转已更新：dir ' + key.props.dir + '°', 'ok', 1600);
      else toast('位置已更新：x ' + key.props.x + ' · y ' + key.props.y, 'ok', 1600);
    }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
function studioBeginPan(ev) {
  const cv = $('#stCanvas');
  if (!cv) return;
  ev.preventDefault();
  const sx = ev.clientX, sy = ev.clientY;
  const p0x = STUDIO.panX || 0, p0y = STUDIO.panY || 0;
  cv.style.cursor = 'grabbing';
  const move = e => {
    STUDIO.panX = p0x + (e.clientX - sx);
    STUDIO.panY = p0y + (e.clientY - sy);
    studioDrawOnly();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    cv.style.cursor = '';
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
function bindStageDrag() {
  const cv = $('#stCanvas');
  if (!cv || cv._stageDragBound) return;
  cv._stageDragBound = true;
  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    const raw = studioCanvasRawPoint(ev);
    if (!raw) return;
    studioSetZoom((STUDIO.zoom || 1) * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), raw);
  }, { passive: false });
  cv.addEventListener('pointerdown', ev => {
    if (ev.button === 1) { studioBeginPan(ev); return; }
    if (ev.button !== 0) return;
    const pt = studioCanvasPoint(ev);
    if (!pt) return;
    const partId = studioSelectedPartId();
    const pos = (STUDIO._positions || {})[partId];
    const mode = studioHitHandle(pt, pos);
    if (mode) { studioBeginPartDrag(ev, partId, mode); return; }
    const hit = studioHitPart(pt);
    if (hit) { ev.preventDefault(); studioSelectCanvasPart(hit); }
  });
  cv.addEventListener('pointermove', ev => {
    if (STUDIO._dragState || (ev.buttons & 4)) return;
    const pt = studioCanvasPoint(ev);
    if (!pt) return;
    const pos = (STUDIO._positions || {})[studioSelectedPartId()];
    const mode = studioHitHandle(pt, pos);
    cv.style.cursor = mode === 'x' ? 'ew-resize' : mode === 'y' ? 'ns-resize'
      : mode === 'both' ? 'move' : mode === 'rotate' ? 'grab' : (studioHitPart(pt) ? 'grab' : 'default');
  });
}

/* ---------- 动画项目 / 作品导出导入 ---------- */
function studioDirPath() {
  return S.doc.path ? S.doc.path.replace(/[/\\][^/\\]*$/, '') : (S.modRoot || '');
}
function studioProjectDefaultPath() {
  const dir = studioDirPath();
  return (dir ? dir + '\\' : '') + 'animation.json';
}
function studioProjectObject() {
  return {
    format: 'rusted-animation-project',
    version: 1,
    savedAt: new Date().toISOString(),
    document: { path: S.doc.path || '', name: S.doc.name || '' },
    animation: {
      name: STUDIO.name,
      params: JSON.parse(JSON.stringify(STUDIO.params || {})),
      keys: JSON.parse(JSON.stringify(STUDIO.keys || [])),
      bake: !!STUDIO.bake,
      bakeStep: STUDIO.bakeStep,
    },
  };
}
function studioSetProjectInfo(path) {
  STUDIO.projectPath = path || '';
  const el = $('#stProjectInfo');
  if (!el) return;
  if (path) {
    el.textContent = '项目：' + String(path).replace(/^.*[\\/]/, '');
    el.title = path;
  } else {
    el.textContent = '项目文件：animation.json（导出时生成，不写入 ini）';
    el.title = '';
  }
}
function studioApplyProject(obj, path) {
  const a = obj && obj.animation ? obj.animation : obj;
  if (!a || !Array.isArray(a.keys)) throw new Error('不是有效的动画项目 JSON');
  STUDIO.name = String(a.name || STUDIO.name || 'animation_2');
  STUDIO.params = Object.assign(defaultParams(), a.params || {});
  STUDIO.keys = a.keys.filter(k => k && k.part && isFinite(k.time))
    .map(k => ({
      time: Number(k.time), part: String(k.part), props: Object.assign({}, k.props || {}),
      ease: k.ease || 'linear', bezier: Array.isArray(k.bezier) ? k.bezier.slice() : undefined,
    }));
  if (isFinite(Number(a.bakeStep))) STUDIO.bakeStep = normalizeBakeStep(a.bakeStep);
  if (typeof a.bake === 'boolean') STUDIO.bake = a.bake;
  STUDIO.keys.sort((x, y) => x.time - y.time || partOrder(x.part) - partOrder(y.part));
  STUDIO.t = 0;
  STUDIO.selKey = null;
  STUDIO.formOpen = !STUDIO.keys.length;
  studioSetProjectInfo(path || '');
  studioRefreshAll();
}
function exportAnimProject() {
  const def = STUDIO.projectPath || studioProjectDefaultPath();
  openModal('导出动画项目（animation.json）',
    '<div class="form-row"><label>保存到</label><input id="epPath" value="' + esc(def) + '" spellcheck="false"></div>' +
    '<div class="form-row"><label></label><span class="tip">项目文件包含关键帧、缓动、参数与步长，不写入 ini，也不影响游戏读取。</span></div>',
    '<button class="btn primary" id="epOk">导出项目</button><button class="btn" id="mClose">取消</button>');
  $('#epOk').onclick = async () => {
    const path = $('#epPath').value.trim();
    if (!path) return;
    let text;
    try { text = JSON.stringify(studioProjectObject(), null, 2); }
    catch (e) { toast('项目序列化失败：' + esc(e.message), 'err'); return; }
    const r = await fetch('/api/file/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, text }),
    });
    const d = await r.json();
    if (d.error) { toast('导出项目失败：' + esc(d.error), 'err', 4200); return; }
    studioSetProjectInfo(d.path);
    closeModal();
    toast('项目已导出到 <b>' + esc(d.path) + '</b>（含 animation 信息）', 'ok', 4200);
  };
}
function importAnimProject() {
  openModal('导入动画项目（animation.json）',
    '<div class="form-row"><label>项目文件</label><input id="ipPath" value="' + esc(STUDIO.projectPath || studioProjectDefaultPath()) + '" spellcheck="false"></div>' +
    '<div class="form-row"><label></label><span class="tip">选择一个由「导出项目」生成的 animation.json；可选文件管理器中复制完整路径。</span></div>',
    '<button class="btn primary" id="ipOk">读取项目</button><button class="btn" id="mClose">取消</button>');
  $('#ipOk').onclick = async () => {
    const path = $('#ipPath').value.trim();
    if (!path) return;
    const r = await fetch('/api/file/load?path=' + encodeURIComponent(path));
    const d = await r.json();
    if (d.error || d.text == null) { toast(d.error || '读不到项目文件', 'err', 4200); return; }
    let obj;
    try { obj = JSON.parse(d.text); } catch (e) { toast('项目 JSON 解析失败：' + esc(e.message), 'err', 4200); return; }
    try { studioApplyProject(obj, d.path); } catch (e) { toast('项目加载失败：' + esc(e.message), 'err', 4200); return; }
    closeModal();
    toast('已导入项目 <b>' + esc(d.name || '') + '</b>，共 ' + STUDIO.keys.length + ' 个源关键帧', 'ok', 4200);
  };
}
function exportAnimWork() {
  const defName = STUDIO.name || 'animation';
  openModal('导出作品（游戏 ini / zip）',
    '<div class="form-row"><label>动画段名</label><input id="ewName" value="' + esc(defName) + '" spellcheck="false"></div>' +
    '<div class="form-row"><label>输出位置</label><label class="mini-check"><input type="radio" name="ewMode" value="output" checked> 程序根目录 output 文件夹</label>' +
    '<label class="mini-check"><input type="radio" name="ewMode" value="custom"> 自定义路径</label></div>' +
    '<div class="form-row"><label>自定义路径</label><input id="ewPath" placeholder="例如 D:\\动画\\我的动画.zip" disabled></div>' +
    '<div class="form-row"><label>打包</label><label class="mini-check"><input type="checkbox" id="ewZip" checked> 打包成 zip（只含 ini，不含 animation.json）</label></div>' +
    '<div class="form-row"><label></label><span class="tip">导出的是烘焙后的游戏作品；项目文件请用「导出项目」。</span></div>',
    '<button class="btn primary" id="ewOk">导出作品</button><button class="btn" id="mClose">取消</button>');
  $$('input[name="ewMode"]').forEach(r => r.onchange = () => {
    const custom = $$('input[name="ewMode"]').find(x => x.checked).value === 'custom';
    $('#ewPath').disabled = !custom;
  });
  $('#ewOk').onclick = async () => {
    const name = ($('#ewName').value || 'animation').trim();
    const custom = $$('input[name="ewMode"]').find(x => x.checked).value === 'custom';
    const path = custom ? $('#ewPath').value.trim() : '';
    if (custom && !path) { toast('请填写自定义输出路径', 'err'); return; }
    const text = '[' + name + ']\n' + studioEntries().map(e => e.key + ': ' + e.value).join('\n') + '\n';
    const r = await fetch('/api/anim/export-work', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text, zip: $('#ewZip').checked, output: !custom, path }),
    });
    const d = await r.json();
    if (d.error) { toast('导出作品失败：' + esc(d.error), 'err', 4200); return; }
    closeModal();
    toast('作品已导出到 <b>' + esc(d.path) + '</b>', 'ok', 5000);
  };
}
function importAnimWork() {
  openModal('导入作品（ini / zip）',
    '<div class="form-row"><label>作品文件</label><input id="iwPath" placeholder="ini / txt / zip 的完整路径" spellcheck="false"></div>' +
    '<div id="iwPick" class="form-row hidden"><label>动画段</label><select id="iwSelect"></select></div>' +
    '<div class="form-row"><label></label><span class="tip">导入的是游戏作品（烘焙后的关键帧），不是项目 JSON。</span></div>',
    '<button class="btn primary" id="iwOk">读取并导入</button><button class="btn" id="mClose">取消</button>');
  $('#iwOk').onclick = async () => {
    const path = $('#iwPath').value.trim();
    if (!path) return;
    const r = await fetch('/api/anim/import-work', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const d = await r.json();
    if (d.error && !d.text) { toast(d.error, 'err', 4200); return; }
    const secs = parseIni(d.text || '').filter(s => deriveSecId(s.name) === 'animation');
    if (!secs.length) { toast('文件里没有 [animation_xxx] 段', 'err', 4200); return; }
    if (secs.length === 1) { loadImportedWork(secs[0]); return; }
    $('#iwPick').classList.remove('hidden');
    $('#iwSelect').innerHTML = secs.map((s, i) => '<option value="' + i + '">' + esc(s.name) + '</option>').join('');
    $('#iwOk').textContent = '导入选中的段';
    $('#iwOk').onclick = () => {
      const i = parseInt($('#iwSelect').value, 10) || 0;
      loadImportedWork(secs[i]);
    };
  };
  function loadImportedWork(sec) {
    loadStudioFromEntries(sec.name, sec.entries.map(e => ({ key: e.key, value: e.value })));
    studioSetProjectInfo('');
    studioRefreshAll();
    closeModal();
    toast('已导入作品 <b>' + esc(sec.name) + '</b>（' + STUDIO.keys.length + ' 个关键帧）', 'ok', 4200);
  }
}

/* ---------- 动画编辑撤销 / 重做 ---------- */
function studioHistoryState() {
  studioCollectParams();
  return {
    name: STUDIO.name,
    params: JSON.parse(JSON.stringify(STUDIO.params || {})),
    keys: JSON.parse(JSON.stringify(STUDIO.keys || [])),
    bake: !!STUDIO.bake,
    bakeStep: STUDIO.bakeStep,
  };
}
function studioHistoryUpdateButtons() {
  const u = $('#stUndo'), r = $('#stRedo');
  if (u) u.disabled = !(STUDIO.history && STUDIO.hIndex > 0);
  if (r) r.disabled = !(STUDIO.history && STUDIO.hIndex < STUDIO.history.length - 1);
}
function studioHistoryReset() {
  if (STUDIO._hTimer) { clearTimeout(STUDIO._hTimer); STUDIO._hTimer = 0; }
  STUDIO.history = [studioHistoryState()];
  STUDIO.hIndex = 0;
  studioHistoryUpdateButtons();
}
function studioHistoryCommit() {
  if (STUDIO._hApplying) return;
  if (STUDIO._hTimer) { clearTimeout(STUDIO._hTimer); STUDIO._hTimer = 0; }
  const snap = studioHistoryState();
  const str = JSON.stringify(snap);
  if (STUDIO.hIndex >= 0 && STUDIO.history[STUDIO.hIndex] &&
      JSON.stringify(STUDIO.history[STUDIO.hIndex]) === str) {
    studioHistoryUpdateButtons();
    return;
  }
  STUDIO.history = STUDIO.history.slice(0, STUDIO.hIndex + 1);
  STUDIO.history.push(snap);
  if (STUDIO.history.length > 80) STUDIO.history.shift();
  STUDIO.hIndex = STUDIO.history.length - 1;
  studioHistoryUpdateButtons();
}
function studioHistorySchedule() {
  if (STUDIO._hApplying) return;
  if (STUDIO._hTimer) clearTimeout(STUDIO._hTimer);
  STUDIO._hTimer = setTimeout(() => {
    STUDIO._hTimer = 0;
    studioHistoryCommit();
  }, 600);
}
function studioHistoryFlush() {
  if (STUDIO._hTimer) { clearTimeout(STUDIO._hTimer); STUDIO._hTimer = 0; }
  studioHistoryCommit();
}
function studioHistoryApply(snap) {
  if (!snap) return;
  const sel = STUDIO.selKey;
  const selPart = sel ? sel.part : '';
  const selTime = sel ? sel.time : null;
  STUDIO._hApplying = true;
  try {
    studioPlay(false);
    STUDIO.name = snap.name;
    STUDIO.params = Object.assign(defaultParams(), JSON.parse(JSON.stringify(snap.params || {})));
    STUDIO.keys = JSON.parse(JSON.stringify(snap.keys || []));
    STUDIO.bake = snap.bake !== false;
    STUDIO.bakeStep = normalizeBakeStep(snap.bakeStep);
    STUDIO.selKey = null;
    STUDIO.formOpen = !STUDIO.keys.length;
    studioRefreshAll();
    if (selPart) {
      const k = STUDIO.keys.find(x => x.part === selPart && Math.abs(x.time - selTime) < 0.0001);
      if (k) {
        STUDIO.selKey = k;
        studioFillFormFromKey(k);
        studioSyncTimelineSelection();
        studioDrawOnly();
        studioRefreshPartPreview();
      }
    }
  } finally {
    STUDIO._hApplying = false;
    studioHistoryUpdateButtons();
  }
}
function studioUndo() {
  if (STUDIO._dragState) return;
  if ($('#modalMask') && !$('#modalMask').classList.contains('hidden')) return;
  studioPlay(false);
  studioHistoryFlush();
  if (!STUDIO.history || STUDIO.hIndex <= 0) { studioHistoryUpdateButtons(); return; }
  STUDIO.hIndex--;
  studioHistoryApply(STUDIO.history[STUDIO.hIndex]);
  toast('已撤销', '', 1200);
}
function studioRedo() {
  if (STUDIO._dragState) return;
  if ($('#modalMask') && !$('#modalMask').classList.contains('hidden')) return;
  studioPlay(false);
  studioHistoryFlush();
  if (!STUDIO.history || STUDIO.hIndex >= STUDIO.history.length - 1) { studioHistoryUpdateButtons(); return; }
  STUDIO.hIndex++;
  studioHistoryApply(STUDIO.history[STUDIO.hIndex]);
  toast('已重做', '', 1200);
}

function buildStudioDom() {
  const div = document.createElement('div');
  div.id = 'studio';
  div.className = 'studio-mask hidden';
  div.innerHTML = `
  <div class="studio">
    <div class="studio-head">
      <span class="st-title">动画制作器</span>
      <span class="st-sub" id="stSub">关键帧 / 缓动 / 时间轴 / 帧动画 → 写入代码</span>
      <span class="st-src" id="stSrcHint" title="缓动源只保存在本机浏览器缓存，不写入 ini，也不会产生额外文件"></span>
      <span class="grow"></span>
      <button class="btn small" id="stClose">关闭</button>
    </div>

    <div class="studio-project-bar">
      <span class="sp-title">项目</span>
      <button class="btn small" id="stUndo" title="撤销 Ctrl+Z" disabled>↶ 撤销</button>
      <button class="btn small" id="stRedo" title="重做 Ctrl+Y" disabled>↷ 重做</button>
      <span class="st-sep2"></span>
      <button class="btn small" id="stImportProject">导入项目</button>
      <button class="btn small" id="stExportProject">导出项目</button>
      <span class="st-sep2"></span>
      <button class="btn small" id="stImportWork">导入作品</button>
      <button class="btn small" id="stExportWork">导出作品</button>
      <span class="grow"></span>
      <span class="hint" id="stProjectInfo">项目文件：animation.json（导出时生成，不写入 ini）</span>
    </div>

    <div class="studio-bar">
      <label>段名 <input id="stName" class="mono" style="width:150px" spellcheck="false"></label>
      <label>条件 <select id="stOnActions"></select></label>
      <label>blendIn <input id="stBlendIn" class="mono w60" ></label>
      <label>blendOut <input id="stBlendOut" class="mono w60"></label>
      <label>帧时长缩放 <input id="stScale" class="mono w60" placeholder="1"></label>
      <label>播放频率 <input id="stRate" class="mono w60" placeholder="1"></label>
      <label class="mini-check"><input type="checkbox" id="stPingPong"> 往返播放</label>
    </div>
    <div class="studio-bar">
      <label>载入：</label>
      <select id="stLoadDoc" style="min-width:150px"></select>
      <button class="btn small" id="stLoadBtn">读入这个动画</button>
      <span class="st-sep2"></span>
      <select id="stLoadBag" style="min-width:150px"></select>
      <button class="btn small" id="stLoadBagBtn">从背包载入</button>
      <span class="st-sep2"></span>
      <input id="stSearchMod" class="mono" style="width:120px" placeholder="搜模组动画…">
      <button class="btn small" id="stSearchBtn">搜索</button>
      <select id="stModHits" style="min-width:150px"></select>
      <button class="btn small" id="stLoadModBtn">从文件载入</button>
    </div>

    <div class="studio-main">
      <div class="studio-left">
        <canvas id="stCanvas" width="640" height="420"></canvas>
        <div class="stage-tip" id="stStageTip">拖动部件移动 XY · Ctrl 吸附 · 滚轮缩放 / 中键平移 · 右上 ↻ 旋转</div>
        <div class="stp-float" id="stPartCard" aria-live="polite">
          <canvas id="stPartThumb" width="88" height="88"></canvas>
          <div class="stp-txt">
            <b id="stPartLabel">主体</b>
            <span id="stPartInfo">读取贴图…</span>
          </div>
          <span class="stp-badge">预览高亮</span>
        </div>
        <div class="studio-transport">
          <button class="btn small" id="stPlay">⏸ 暂停</button>
          <input type="range" id="stTime" min="0" max="2000" value="0" step="10">
          <span class="mono" id="stTimeTxt">0.00s</span>
          <select id="stSpeed" class="w60">
            <option value="0.25">0.25×</option><option value="0.5">0.5×</option>
            <option value="1" selected>1×</option><option value="2">2×</option>
          </select>
          <label class="mini-check"><input type="checkbox" id="stLoop" checked> 循环</label>
          <label>时长 <input id="stDur" class="mono w60" placeholder="自动"></label>
          <label class="st-grid" title="按住 Ctrl 拖动时按网格吸附；旋转也按这个角度步长">网格
            <input id="stGrid" class="mono w60" type="number" min="0.1" max="200" step="0.5" value="5">px</label>
          <span class="st-view-zoom" title="滚轮缩放；中键拖动平移；Ctrl+拖动按网格吸附">
            <button class="icon-btn" id="stViewZoomOut" title="缩小">−</button>
            <span id="stViewZoomVal">100%</span>
            <button class="icon-btn" id="stViewZoomIn" title="放大">＋</button>
          </span>
          <button class="btn small" id="stViewReset" title="恢复 100% 并回到中心">重置视图</button>
          <button class="btn small" id="stFit">回到中心</button>
        </div>
        <div class="studio-readout" id="stReadout"></div>
      </div>

      <div class="studio-right">
        <div class="st-side-tabs">
          <button class="st-side-tab active" data-sttab="keys">关键帧</button>
          <button class="st-side-tab" data-sttab="frames">帧动画</button>
          <button class="st-side-tab" data-sttab="code">代码</button>
        </div>
        <div class="st-pane" id="stPaneKeys">
          <div class="studio-keys-head">关键帧 <span class="cnt" id="stKeyCount">0</span>
            <span class="grow"></span>
            <button class="btn small ghost" id="stAddOpen" title="展开关键帧编辑表单">＋ 添加</button>
            <button class="btn small ghost" id="stClearKeys">清空</button></div>
          <div class="studio-keys" id="stKeys"></div>
          <div class="studio-add" id="stAddPanel">
            <div class="studio-add-head" id="stAddHead">
              <span>关键帧编辑</span>
              <span class="hint" id="stAddSummary">添加新关键帧</span>
              <span class="grow"></span>
              <button class="btn small ghost" id="stFormToggle" type="button">收起</button>
            </div>
            <div class="studio-add-body">
            <div class="sa-row">
              <label>部位 <select id="stPart"></select></label>
              <label>时间 <input id="stKTime" class="mono w60" placeholder="0.5">秒</label>
            </div>
            <div class="sa-row" id="stProps"></div>
            <div class="sa-row sa-ease">
              <label title="这一帧到下一帧的缓动；写入时会烘焙成中间关键帧">缓动
                <select id="stEase" class="ease-select">
                  <option value="linear">线性</option>
                  <option value="easeIn">缓入</option>
                  <option value="easeOut">缓出</option>
                  <option value="easeInOut">缓入缓出</option>
                  <option value="smooth">柔和</option>
                  <option value="backIn">回弹入</option>
                  <option value="backOut">回弹出</option>
                  <option value="bounce">弹跳</option>
                  <option value="custom">自定义曲线</option>
                </select>
              </label>
              <label class="bez-row hidden" id="stBezRow" title="四个数字：x1,y1,x2,y2">
                <input id="stBez" class="mono bez-input" placeholder="0.42,0,0.58,1">
              </label>
              <canvas id="stEaseCurve" width="64" height="64" title="缓动曲线预览"></canvas>
            </div>
            <div class="sa-row">
              <button class="btn small primary" id="stAddKey"
                title="同一部位同一时间会覆盖；缓动优先段首帧，段首为线性时取段尾帧">＋ 添加 / 更新关键帧</button>
              <span class="hint" id="stAddHint">同部位同时间会覆盖</span>
            </div>
            </div>
          </div>
        </div>

        <div class="st-pane hidden" id="stPaneFrames">
          <div class="frame-head">
            <span class="fr-title">主体贴图帧</span>
            <span class="cnt" id="stFrameMeta">读取中…</span>
            <span class="grow"></span>
            <button class="btn small ghost" id="stFrameReload">刷新</button>
          </div>
          <div class="frame-strip" id="stFrameStrip"></div>
          <div class="frame-form">
            <label>序列 <input id="stFrameSeq" class="mono" placeholder="0-7 或 0,1,2"></label>
            <button class="btn small ghost" id="stFrameAll" title="填入全部帧">全部</button>
            <label>帧率 <input id="stFrameFps" class="mono w60" value="10"></label>
            <label>开始 <input id="stFrameStart" class="mono w60" value="0">秒</label>
            <label class="mini-check"><input type="checkbox" id="stFramePP"> 往返</label>
            <button class="btn small primary" id="stFrameGen">生成帧动画</button>
          </div>
          <div class="hint" id="stFrameHint">点帧缩略图可在播放头插入单帧；生成会按帧率写入主体 frame 关键帧。</div>
        </div>

        <div class="st-pane hidden" id="stPaneCode">
          <div class="studio-keys-head">作品代码 <span class="cnt" id="stCodeMeta"></span>
            <span class="grow"></span>
            <button class="btn small ghost" id="stCodeCopy">复制</button>
          </div>
          <pre class="st-code" id="stCodeView"></pre>
          <div class="hint" id="stCodeHint">这里显示写入 ini 的作品代码；缓动按当前步长烘焙，项目 JSON 不写入这里。</div>
        </div>
      </div>
    </div>

    <div class="studio-timeline" id="stTimeline">
      <div class="tl-head">
        <span class="tl-title">时间轴</span>
        <button class="btn small ghost" id="stTlToggle" title="收起 / 展开时间轴">收起</button>
        <span class="grow"></span>
        <span class="tl-zoom">
          <button class="icon-btn" id="stTlZoomOut" title="缩小">−</button>
          <span id="stTlZoomVal">100%</span>
          <button class="icon-btn" id="stTlZoomIn" title="放大">＋</button>
        </span>
        <button class="btn small ghost" id="stTlFit">适应</button>
        <label class="mini-check"><input type="checkbox" id="stTlSnap" checked> 吸附</label>
        <button class="btn small" id="stTlAdd">＋ 播放头处加帧</button>
      </div>
      <div class="tl-body" id="stTlBody">
        <div class="tl-scroll" id="stTlScroll">
          <div class="tl-content" id="stTlContent">
            <div class="tl-gutter" id="stTlGutter"></div>
            <div class="tl-stage" id="stTlStage">
              <div class="tl-ruler" id="stTlRuler"></div>
              <div class="tl-tracks" id="stTlTracks"></div>
            </div>
          </div>
        </div>
        <div class="tl-playhead-layer" id="stTlPlayheadLayer">
          <canvas id="stTlPhCanvas"></canvas>
          <div class="tl-playhead" id="stTlPlayheadLine"><i></i></div>
        </div>
      </div>
    </div>

    <div class="studio-foot">
      <label class="mini-check" id="stBakeWrap" title="RW 只支持线性关键帧；开启后写入/复制时自动把缓动烘焙成中间帧">
        <input type="checkbox" id="stBake" checked> 烘焙缓动</label>
      <label class="st-step" title="缓动烘焙采样步长：0.05 秒 = 每 50ms 插入一个关键帧">
        步长 <input id="stBakeStep" class="mono w60" type="number" min="0.005" max="2" step="0.005" value="0.05" inputmode="decimal"> 秒
      </label>
      <span class="hint" id="stFootHint">写进代码后，编辑器里会出现 [animation_xxx] 段</span>
      <span class="grow"></span>
      <button class="btn small" id="stCopy">复制代码</button>
      <button class="btn small" id="stToBag">存进背包</button>
      <button class="btn primary" id="stWrite">写入代码</button>
    </div>
  </div>`;
  document.body.appendChild(div);

  STUDIO.bakeStep = loadBakeStepPref();
  if ($('#stBakeStep')) $('#stBakeStep').value = STUDIO.bakeStep;
  STUDIO.grid = loadGridPref();
  if ($('#stGrid')) $('#stGrid').value = STUDIO.grid;

  const sel = $('#stOnActions');
  sel.innerHTML = '<option value="">（不限制）</option>' +
    ON_ACTIONS.map(a => '<option value="' + a + '">' + a + '</option>').join('');
  div.addEventListener('click', ev => { if (ev.target === div) closeStudio(); });
  $('#stClose').onclick = closeStudio;
  $('#stUndo').onclick = () => studioUndo();
  $('#stRedo').onclick = () => studioRedo();
  $('#stImportProject').onclick = importAnimProject;
  $('#stExportProject').onclick = exportAnimProject;
  $('#stImportWork').onclick = importAnimWork;
  $('#stExportWork').onclick = exportAnimWork;
  ['stName','stOnActions','stBlendIn','stBlendOut','stScale','stRate','stPingPong'].forEach(id => {
    const el = $('#' + id);
    if (el) el.addEventListener('change', () => {
      studioCollectParams();
      studioHistoryCommit();
      if (STUDIO.stTab === 'code') studioRenderCodeView();
    });
  });
  $('#stPlay').onclick = () => studioPlay(!STUDIO.playing);
  $('#stLoop').onchange = e => { STUDIO.loop = e.target.checked; if (STUDIO.playing) studioStartPhAnimation(); };
  $('#stSpeed').onchange = e => { STUDIO.speed = parseFloat(e.target.value) || 1; if (STUDIO.playing) studioStartPhAnimation(); };
  $('#stTime').oninput = e => {
    studioPlay(false);
    STUDIO.t = parseFloat(e.target.value) / 1000;
    studioDrawOnly();
  };
  $('#stAddKey').onclick = studioAddKey;
  $('#stClearKeys').onclick = () => {
    if (STUDIO.keys.length && !confirm('清空所有关键帧？')) return;
    STUDIO.keys = []; STUDIO.selKey = null; STUDIO.formOpen = true; studioRefreshAll();
  };
  const toggleAddForm = () => {
    STUDIO.formOpen = !STUDIO.formOpen;
    studioApplyFormState();
  };
  if ($('#stAddOpen')) $('#stAddOpen').onclick = () => {
    STUDIO.formOpen = true;
    studioApplyFormState();
    if ($('#stKTime') && !String($('#stKTime').value || '').trim()) {
      $('#stKTime').value = +(STUDIO.t / Math.max(0.001, scaleFactor())).toFixed(2);
    }
    const panel = $('#stAddPanel');
    if (panel) panel.scrollIntoView({ block: 'nearest' });
    if ($('#stKTime')) setTimeout(() => $('#stKTime').focus(), 40);
  };
  if ($('#stAddHead')) $('#stAddHead').onclick = ev => {
    if (ev.target.closest('button')) return;
    toggleAddForm();
  };
  if ($('#stFormToggle')) $('#stFormToggle').onclick = ev => {
    ev.stopPropagation();
    toggleAddForm();
  };
  $('#stWrite').onclick = studioWrite;
  $('#stCopy').onclick = () => {
    const text = '[' + STUDIO.name + ']\n' + studioEntries().map(e => e.key + ': ' + e.value).join('\n') + '\n';
    navigator.clipboard.writeText(text).then(() => toast('动画代码已复制' + (STUDIO.bake ? '（含缓动烘焙帧）' : ''), 'ok'), () => {});
  };
  $('#stCodeCopy').onclick = () => {
    const text = $('#stCodeView') ? $('#stCodeView').textContent : '';
    navigator.clipboard.writeText(text).then(() => toast('作品代码已复制', 'ok'), () => {});
  };
  $('#stToBag').onclick = async () => {
    const entries = studioEntries();
    const ok = await saveBagItem({
      name: STUDIO.name, kind: 'section', note: '动画（' + STUDIO.keys.length + ' 个关键帧）由动画制作器保存',
      payload: { name: STUDIO.name, entries: entries }
    });
    if (ok) toast('动画已存进背包，别的单位可以直接追加', 'ok');
  };
  $('#stLoadBtn').onclick = () => {
    const nm = $('#stLoadDoc').value;
    const sec = S.doc.sections.find(s => s.name === nm);
    if (!sec) { toast('这个段不在当前文件里', 'err'); return; }
    loadStudioFromSection(sec);
    studioRefreshAll();
    toast('已载入 <b>[' + esc(nm) + ']</b>', 'ok');
  };
  $('#stLoadBagBtn').onclick = () => {
    const id = $('#stLoadBag').value;
    const it = S.bag.find(x => x.id === id);
    if (!it || !it.payload || !it.payload.entries) { toast('背包里没有可用的动画模块', 'err'); return; }
    loadStudioFromEntries(it.payload.name || it.name, it.payload.entries);
    studioRefreshAll();
    toast('已从背包载入 <b>' + esc(it.name) + '</b>', 'ok');
  };
  $('#stSearchBtn').onclick = () => {
    const q = ($('#stSearchMod').value || '').trim().toLowerCase();
    if (!S.scan || !S.scan.ok || !S.scan.animations) {
      toast('还没扫描到模组动画，先等后台扫描完成或点「模组体检」扫一次', '', 3600);
      return;
    }
    const hits = S.scan.animations.filter(a => !q || a.name.toLowerCase().indexOf(q) >= 0).slice(0, 300);
    $('#stModHits').innerHTML = hits.map((a, i) =>
      '<option value="' + i + '">' + esc(a.name) + '　[' + esc(a.rel) + ']</option>').join('') ||
      '<option value="">（没有匹配）</option>';
    $('#stModHits').dataset.hits = JSON.stringify(hits);
  };
  $('#stLoadModBtn').onclick = async () => {
    let hits = [];
    try { hits = JSON.parse($('#stModHits').dataset.hits || '[]'); } catch (e) { hits = []; }
    const h = hits[parseInt($('#stModHits').value, 10)];
    if (!h) { toast('先搜索并从结果里选一个', 'err'); return; }
    const d = await (await fetch('/api/file/load?path=' + encodeURIComponent(h.path))).json();
    if (d.error || d.text == null) { toast(d.error || '读不到文件', 'err'); return; }
    const secs = parseIni(d.text);
    const sec = secs.find(s => s.name === h.name);
    if (!sec) { toast('文件里没找到这个动画段', 'err'); return; }
    loadStudioFromEntries(h.name, sec.entries.map(e => ({ key: e.key, value: e.value })));
    studioRefreshAll();
    toast('已从 <b>' + esc(h.rel) + '</b> 载入动画 <b>' + esc(h.name) + '</b>', 'ok', 4000);
  };

  /* ---- 新增：缓动 / 时间轴 / 帧动画 ---- */
  $$('.st-side-tab').forEach(b => b.onclick = () => studioSetTab(b.dataset.sttab));
  $('#stPart').onchange = () => {
    if (STUDIO.selKey && STUDIO.selKey.part !== $('#stPart').value) STUDIO.selKey = null;
    studioRefreshProps();
    studioSyncTimelineSelection();
    studioRenderTimeline();
    studioDrawOnly();
    studioRefreshPartPreview();
  };
  $('#stEase').onchange = () => {
    const custom = $('#stEase').value === 'custom';
    $('#stBezRow').classList.toggle('hidden', !custom);
    if (custom && !($('#stBez').value || '').trim()) $('#stBez').value = EASE_PRESETS.custom.bez.join(',');
    studioDrawEaseCurve();
  };
  $('#stBez').oninput = studioDrawEaseCurve;
  $('#stBake').onchange = e => {
    STUDIO.bake = !!e.target.checked;
    studioRenderKeys();
    studioRenderCodeView();
    studioHistoryCommit();
    toast(STUDIO.bake ? '写入时会把缓动烘焙成中间关键帧' : '写入时保留稀疏关键帧（游戏内为线性）', '', 2600);
  };
  if ($('#stGrid')) $('#stGrid').onchange = () => {
    STUDIO.grid = normalizeGrid($('#stGrid').value);
    $('#stGrid').value = STUDIO.grid;
    saveGridPref();
    studioDrawOnly();
  };
  const zoomAtCenter = f => {
    const cx = (STUDIO._drawW || 1) / 2, cy = (STUDIO._drawH || 1) / 2;
    studioSetZoom((STUDIO.zoom || 1) * f, { x: cx, y: cy });
  };
  if ($('#stViewZoomOut')) $('#stViewZoomOut').onclick = () => zoomAtCenter(1 / 1.2);
  if ($('#stViewZoomIn')) $('#stViewZoomIn').onclick = () => zoomAtCenter(1.2);
  if ($('#stViewReset')) $('#stViewReset').onclick = studioResetView;
  if ($('#stFit')) $('#stFit').onclick = studioRecenterView;
  if ($('#stBakeStep')) $('#stBakeStep').onchange = () => {
    STUDIO.bakeStep = normalizeBakeStep($('#stBakeStep').value);
    $('#stBakeStep').value = STUDIO.bakeStep;
    saveBakeStepPref();
    studioRenderKeys();
    studioRenderCodeView();
    studioHistoryCommit();
    toast('缓动步长：' + STUDIO.bakeStep + ' 秒（每 ' + Math.round(STUDIO.bakeStep * 1000) + 'ms 一个采样）', 'ok', 2200);
  };
  $('#stTlToggle').onclick = () => {
    STUDIO.tlCollapsed = !STUDIO.tlCollapsed;
    STUDIO._sizeDirty = true;
    STUDIO._phSizeDirty = true;
    STUDIO._phFirst = true;
    $('#stTimeline').classList.toggle('collapsed', STUDIO.tlCollapsed);
    $('#stTlToggle').textContent = STUDIO.tlCollapsed ? '展开' : '收起';
    if (!STUDIO.tlCollapsed) studioRenderTimeline();
    studioDrawOnly();
    if (STUDIO.playing) studioStartPhAnimation();
  };
  $('#stTlZoomOut').onclick = () => { STUDIO.pps = Math.max(40, Math.round(STUDIO.pps / 1.4)); studioRenderTimeline(); };
  $('#stTlZoomIn').onclick = () => { STUDIO.pps = Math.min(400, Math.round(STUDIO.pps * 1.4)); studioRenderTimeline(); };
  $('#stTlScroll').addEventListener('wheel', ev => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    STUDIO.pps = Math.max(40, Math.min(400, Math.round(STUDIO.pps * (ev.deltaY < 0 ? 1.15 : 1 / 1.15))));
    studioRenderTimeline();
  }, { passive: false });
  $('#stTlFit').onclick = () => {
    const sc = $('#stTlScroll');
    const w = Math.max(240, (sc ? sc.clientWidth : 600) - 112);
    STUDIO.pps = Math.max(40, Math.min(400, Math.round(w / Math.max(0.2, timelineDuration()))));
    studioRenderTimeline();
  };
  $('#stTlSnap').onchange = e => { STUDIO.snap = !!e.target.checked; };
  $('#stTlAdd').onclick = studioTimelineAdd;
  $('#stFrameReload').onclick = () => { studioRefreshFrames(); toast('已刷新帧列表', 'ok', 1600); };
  $('#stFrameAll').onclick = () => {
    const info = bodyFrameInfo();
    if (!info.ok) { toast(info.msg || '帧不可用', 'err'); return; }
    $('#stFrameSeq').value = info.spec.count > 1 ? '0-' + (info.spec.count - 1) : '0';
  };
  $('#stFrameGen').onclick = studioGenerateFrames;
  const stageEl = $('#stTlStage');
  if (stageEl) stageEl.addEventListener('pointerdown', ev => {
    if (ev.target.closest('.tl-dot')) return;
    studioTimelineSeekPointer(ev);
  });
  const tracksEl = $('#stTlTracks');
  if (tracksEl) tracksEl.addEventListener('pointerdown', ev => {
    const dot = ev.target.closest('.tl-dot');
    if (!dot) return;
    const k = STUDIO.keys[parseInt(dot.dataset.k, 10)];
    if (k) studioBeginKeyDrag(ev, k);
  });
  const gutterEl = $('#stTlGutter');
  if (gutterEl) gutterEl.addEventListener('click', ev => {
    const lab = ev.target.closest('[data-part]');
    if (!lab) return;
    $('#stPart').value = lab.dataset.part;
    STUDIO.selKey = null;
    studioRefreshProps();
    studioSyncTimelineSelection();
    studioRenderTimeline();
    studioDrawOnly();
    studioRefreshPartPreview();
  });
  const tlScroll = $('#stTlScroll');
  let tlScrollTimer = 0;
  if (tlScroll) tlScroll.addEventListener('scroll', () => {
    if (tlScrollTimer) return;
    tlScrollTimer = setTimeout(() => { tlScrollTimer = 0; studioUpdatePlayhead(); }, 60);
  }, { passive: true });
  const phLayer = $('#stTlPlayheadLayer');
  if (phLayer && window.ResizeObserver) {
    new ResizeObserver(() => { STUDIO._phSizeDirty = true; STUDIO._phFirst = true; }).observe(phLayer);
  }
  bindStageDrag();
  document.addEventListener('keydown', studioKeydown);
  window.addEventListener('resize', () => {
    if (!$('#studio') || $('#studio').classList.contains('hidden')) return;
    STUDIO._sizeDirty = true;
    STUDIO._phSizeDirty = true;
    STUDIO._phFirst = true;
    studioDrawOnly();
    studioRenderTimeline();
  });
}

/* ---- 关键帧表单 ---- */
/** 属性表单即时写回当前选中关键帧：改 x/y/dir/alpha 不再需要先点“更新” */
function studioLiveProp(inp) {
  const k = STUDIO.selKey;
  if (!k || !inp || !inp.dataset) return;
  const part = $('#stPart');
  if (part && k.part !== part.value) return;
  const prop = inp.dataset.prop;
  let v;
  if (inp.tagName === 'SELECT') {
    v = inp.value;
    if (v === '') { delete k.props[prop]; }
    else k.props[prop] = v;
  } else {
    const txt = String(inp.value || '').trim();
    if (txt === '') return;                 // 清空留给“更新”按钮决定是否删除
    if (!/^-?[\d.]+$/.test(txt)) return;
    v = parseFloat(txt);
    if (!isFinite(v)) return;
    k.props[prop] = v;
  }
  studioRequestDraw();
  studioHistorySchedule();
  if (STUDIO.stTab === 'code') {
    if (STUDIO._liveCodeTimer) clearTimeout(STUDIO._liveCodeTimer);
    STUDIO._liveCodeTimer = setTimeout(() => { STUDIO._liveCodeTimer = 0; studioRenderCodeView(); }, 80);
  }
}

function studioRefreshProps() {
  const partId = $('#stPart').value || 'body';
  const kind = partId.replace(/\d+$/, '') || 'body';
  const props = PART_PROPS[kind] || ['x', 'y'];
  let html = props.map(p => '<label>' + p + ' <input class="mono w60" data-prop="' + p + '"></label>').join('');
  if (kind === 'effect') {
    const names = docEffectNames();
    html += '<label>name <select data-prop="name" class="field-w">' +
      '<option value="">（选特效）</option>' +
      names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('') +
      '</select></label>';
    if (!names.length) html += '<span class="hint">这个文件里还没有 [effect_xxx] 段</span>';
  }
  if (kind === 'body') html += '<span class="hint">主体只支持 frame / scale</span>';
  $('#stProps').innerHTML = html;
  const nameSel = $('#stProps [data-prop="name"]');
  if (nameSel) nameSel.onchange = () => { studioRefreshPartPreview(); studioDrawOnly(); };
  $$('#stProps [data-prop]').forEach(inp => {
    inp.addEventListener('input', () => studioLiveProp(inp));
    inp.addEventListener('change', () => studioLiveProp(inp));
    inp.addEventListener('focusout', () => { studioHistoryFlush(); });
  });
  const k = STUDIO.selKey;
  if (k && k.part === partId) studioLoadEaseForm(k);
  else studioSyncEaseForm();
}

/* ---- 缓动曲线表单 ---- */
function parseBezText(s) {
  const arr = String(s || '').split(/[,，\s]+/).filter(Boolean).map(Number);
  if (arr.length !== 4 || arr.some(v => !isFinite(v))) return null;
  if (arr[0] < 0 || arr[0] > 1 || arr[2] < 0 || arr[2] > 1) return null;
  return arr;
}
function studioSyncEaseForm(key) {
  const el = $('#stEase');
  if (!el) return;
  const ease = (key && key.ease) || el.value || 'linear';
  el.value = EASE_PRESETS[ease] ? ease : 'linear';
  if (el.value === 'custom') {
    const b = (key && key.bezier) || parseBezText($('#stBez') ? $('#stBez').value : '') || EASE_PRESETS.custom.bez;
    $('#stBez').value = b.join(',');
  }
  const row = $('#stBezRow');
  if (row) row.classList.toggle('hidden', el.value !== 'custom');
  studioDrawEaseCurve();
}
function studioLoadEaseForm(key) {
  const el = $('#stEase');
  if (!el) return;
  const ease = (key && key.ease) || 'linear';
  el.value = EASE_PRESETS[ease] ? ease : 'linear';
  if ($('#stBez')) $('#stBez').value = ((key && key.bezier) || EASE_PRESETS.custom.bez).join(',');
  if ($('#stBezRow')) $('#stBezRow').classList.toggle('hidden', el.value !== 'custom');
  studioDrawEaseCurve();
}
function studioReadEaseForm() {
  const ease = ($('#stEase') && $('#stEase').value) || 'linear';
  if (ease !== 'custom') return { ease: ease };
  const bez = parseBezText($('#stBez') && $('#stBez').value);
  if (!bez) {
    toast('自定义曲线要填 4 个数字：x1,y1,x2,y2，例如 0.42,0,0.58,1', 'err', 3600);
    return null;
  }
  return { ease: 'custom', bezier: bez };
}
function studioDrawEaseCurve() {
  const cv = $('#stEaseCurve');
  if (!cv) return;
  const ctx = pixelCtx(cv);
  const W = cv.width, H = cv.height, pad = 10;
  const x0 = pad, y0 = H - pad, iw = W - pad * 2, ih = H - pad * 2;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fafafc';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const x = x0 + iw * i / 4, y = y0 - ih * i / 4;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 - ih); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + iw, y); ctx.stroke();
  }
  ctx.strokeStyle = '#d2d2d7';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + iw, y0 - ih); ctx.stroke();
  ctx.setLineDash([]);
  const k = { ease: ($('#stEase') && $('#stEase').value) || 'linear' };
  if (k.ease === 'custom') k.bezier = parseBezText($('#stBez') && $('#stBez').value) || EASE_PRESETS.custom.bez;
  ctx.strokeStyle = '#0066cc';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const p = i / 60;
    const v = easeValue(p, k);
    const x = x0 + iw * p;
    const y = y0 - ih * v;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function studioAddKey() {
  const partId = $('#stPart').value || 'body';
  const time = parseFloat($('#stKTime').value);
  if (!isFinite(time) || time < 0) { toast('时间要填数字（秒），例如 0.5', 'err'); return; }
  const i = STUDIO.keys.findIndex(k => k.part === partId && Math.abs(k.time - time) < 0.0001);
  // 更新已有帧时以原属性为底，只覆盖表单里实际显示的属性；
  // 这样不会因为表单没列出 y 等字段，一点“更新”就把原值抹掉。
  const props = i >= 0 ? Object.assign({}, STUDIO.keys[i].props) : {};
  $$('#stProps [data-prop]').forEach(inp => {
    const k = inp.dataset.prop;
    const v = String(inp.value || '').trim();
    if (v === '') { delete props[k]; return; }
    props[k] = (/^-?[\d.]+$/.test(v) && inp.tagName !== 'SELECT') ? parseFloat(v) : v;
  });
  if (!Object.keys(props).length) { toast('至少要填一个属性值', 'err'); return; }
  const ez = studioReadEaseForm();
  if (!ez) return;
  let key;
  if (i >= 0) {
    key = STUDIO.keys[i];
    key.props = props;
    key.ease = ez.ease;
    key.bezier = ez.bezier;
  } else {
    key = { time: time, part: partId, props: props, ease: ez.ease, bezier: ez.bezier };
    STUDIO.keys.push(key);
  }
  STUDIO.selKey = key;
  STUDIO.keys.sort((a, b) => a.time - b.time || partOrder(a.part) - partOrder(b.part));
  STUDIO.t = time * scaleFactor();
  studioRefreshAll();
  toast((i >= 0 ? '已更新 ' : '已添加 ') + esc(partId) + ' @ ' + fmtTime(time) +
    ' · ' + easeLabel(key), 'ok', 2200);
}

function studioApplyFormState() {
  const panel = $('#stAddPanel');
  if (!panel) return;
  panel.classList.toggle('collapsed', !STUDIO.formOpen);
  const btn = $('#stFormToggle');
  if (btn) btn.textContent = STUDIO.formOpen ? '收起' : '展开';
  const sm = $('#stAddSummary');
  if (sm) {
    const k = STUDIO.selKey;
    sm.textContent = k ? (k.part + ' @ ' + fmtTime(k.time)) : (STUDIO.keys.length ? '添加新关键帧' : '添加第一帧');
  }
}

function studioRenderKeys() {
  const box = $('#stKeys');
  const cnt = STUDIO.bake ? bakeAnimKeys(STUDIO.keys).length : STUDIO.keys.length;
  $('#stKeyCount').textContent = STUDIO.keys.length + ' 个' + (STUDIO.bake && cnt > STUDIO.keys.length ? ' → 烘焙 ' + cnt : '');
  $('#stKeyCount').title = '源关键帧 ' + STUDIO.keys.length + ' 个' +
    (STUDIO.bake && cnt > STUDIO.keys.length ? '；写入时烘焙为 ' + cnt + ' 个关键帧' : '');
  if (!STUDIO.keys.length) {
    box.innerHTML = '<div class="miss-ok">还没有关键帧<br>点上方「＋ 添加」展开编辑表单，或点下方「关键帧编辑」</div>';
    return;
  }
  box.innerHTML = STUDIO.keys.map((k, i) => {
    const sel = k === STUDIO.selKey;
    const ez = (k.ease && k.ease !== 'linear') ? '<span class="kr-ease" title="到下一帧的缓动">' + esc(easeLabel(k)) + '</span>' : '';
    return '<div class="key-row' + (sel ? ' sel' : '') + '" data-k="' + i +
      '" title="' + esc(fmtTime(k.time) + ' · ' + k.part + ' · ' + fmtProps(k.props) + ' · ' + easeLabel(k)) + '">' +
      '<span class="kr-time">' + fmtTime(k.time) + '</span>' +
      '<span class="kr-part" style="--tc:' + partColor(k.part) + '">' + esc(k.part) + '</span>' +
      '<span class="kr-val">' + esc(fmtProps(k.props)) + '</span>' + ez +
      '<span class="grow"></span>' +
      '<button class="icon-btn" data-kedit="' + i + '" title="载入到表单编辑">✎</button>' +
      '<button class="icon-btn danger" data-kdel="' + i + '" title="删除">×</button>' +
      '</div>';
  }).join('');
  box.onclick = ev => {
    const ed = ev.target.closest('[data-kedit]');
    if (ed) {
      const k = STUDIO.keys[parseInt(ed.dataset.kedit, 10)];
      studioLoadKey(k);
      return;
    }
    const del = ev.target.closest('[data-kdel]');
    if (del) {
      const k = STUDIO.keys[parseInt(del.dataset.kdel, 10)];
      if (k === STUDIO.selKey) STUDIO.selKey = null;
      STUDIO.keys.splice(parseInt(del.dataset.kdel, 10), 1);
      studioRefreshAll();
      return;
    }
    const row = ev.target.closest('[data-k]');
    if (row) studioLoadKey(STUDIO.keys[parseInt(row.dataset.k, 10)]);
  };
}

function partColor(part) {
  if (part === 'body') return '#0066cc';
  if (part.startsWith('turret')) return '#d70015';
  if (part.startsWith('leg')) return '#1d8348';
  if (part.startsWith('arm')) return '#a05a00';
  if (part.startsWith('effect')) return '#5e5ce6';
  return '#7a7a7a';
}

function studioFillFormFromKey(k) {
  if (!k) return;
  const part = $('#stPart');
  if (part && part.value !== k.part) part.value = k.part;
  studioRefreshProps();
  if ($('#stKTime')) $('#stKTime').value = +(Math.round(k.time * 1000) / 1000);
  $$('#stProps [data-prop]').forEach(inp => {
    const v = k.props ? k.props[inp.dataset.prop] : undefined;
    inp.value = v !== undefined ? v : '';
  });
  studioLoadEaseForm(k);
}

function studioLoadKey(k) {
  if (!k) return;
  STUDIO.selKey = k;
  STUDIO.formOpen = true;
  studioApplyFormState();
  studioFillFormFromKey(k);
  STUDIO.t = k.time * scaleFactor();
  studioDrawOnly();
  studioRefreshPartPreview();
  studioRenderKeys();
  studioRenderTimeline();
  studioSetTab('keys');
}

function studioSetTab(tab) {
  STUDIO.stTab = tab || 'keys';
  $$('.st-side-tab').forEach(b => b.classList.toggle('active', b.dataset.sttab === STUDIO.stTab));
  const pk = $('#stPaneKeys'), pf = $('#stPaneFrames'), pc = $('#stPaneCode');
  if (pk) pk.classList.toggle('hidden', STUDIO.stTab !== 'keys');
  if (pf) pf.classList.toggle('hidden', STUDIO.stTab !== 'frames');
  if (pc) pc.classList.toggle('hidden', STUDIO.stTab !== 'code');
  if (STUDIO.stTab === 'frames') studioRefreshFrames();
  if (STUDIO.stTab === 'code') studioRenderCodeView();
}

function studioRenderCodeView() {
  const pre = $('#stCodeView');
  if (!pre) return;
  const entries = studioEntries();
  const code = '[' + STUDIO.name + ']\n' + entries.map(e => e.key + ': ' + e.value).join('\n') + '\n';
  pre.textContent = code;
  const meta = $('#stCodeMeta');
  if (meta) meta.textContent = entries.length + ' 行';
}

/* ---------------- 时间轴 ---------------- */
const TL_PAD = 10;
function timelineDuration() {
  let mx = 0;
  for (const k of STUDIO.keys) mx = Math.max(mx, k.time);
  const scale = Math.max(0.01, scaleFactor());
  const play = studioDuration() / scale;
  return Math.max(0.5, mx + 0.25, play + 0.05);
}
function studioSnapTime(t) {
  if (!STUDIO.snap) return Math.max(0, Math.round(t * 1000) / 1000);
  return Math.max(0, Math.round(t / 0.05) * 0.05);
}
function studioPhLabelText() {
  const line = $('#stTlPlayheadLine');
  if (!line) return;
  const i = line.querySelector('i');
  if (!i) return;
  const raw = STUDIO.t / Math.max(0.001, scaleFactor());
  const txt = raw.toFixed(2) + 's';
  if (i.textContent !== txt) i.textContent = txt;
}

/** 播放时用 CSS 动画驱动播放头：浏览器合成器直接跑，主线程零逐帧更新 */
function studioStartPhAnimation() {
  if (STUDIO.tlCollapsed) return;
  const line = $('#stTlPlayheadLine');
  const cv = $('#stTlPhCanvas');
  if (!line) return;
  if (cv) cv.style.display = 'none';
  line.style.display = 'block';
  const total = timelineDuration();
  const scale = Math.max(0.001, scaleFactor());
  const speed = Math.max(0.01, STUDIO.speed || 1);
  if (!(total > 0)) return;
  const raw = Math.max(0, Math.min(total, STUDIO.t / scale));
  const durMs = Math.max(1, total * scale / speed * 1000);
  const sc = $('#stTlScroll');
  const sx = sc ? sc.scrollLeft : 0;
  const from = TL_PAD - sx;
  const to = TL_PAD + total * STUDIO.pps - sx;
  // CSS 变量放在 keyframes 里在 Edge 下会把动画时长弄成异常值；
  // 直接写一条固定像素的 keyframes，动画才能正常交给合成器。
  let phStyle = document.getElementById('stTlPhStyle');
  if (!phStyle) {
    phStyle = document.createElement('style');
    phStyle.id = 'stTlPhStyle';
    document.head.appendChild(phStyle);
  }
  phStyle.textContent = '@keyframes tlPhRun{from{transform:translateX(' + from + 'px)}to{transform:translateX(' + to + 'px)}}';
  line.style.animation = 'none';
  void line.offsetWidth; // 重启动画
  line.style.animationName = 'tlPhRun';
  line.style.animationDuration = durMs + 'ms';
  line.style.animationTimingFunction = 'linear';
  line.style.animationIterationCount = STUDIO.loop ? 'infinite' : '1';
  line.style.animationFillMode = 'both';
  line.style.animationDelay = (-(raw / total) * durMs) + 'ms';
  line.style.animationPlayState = 'running';
  studioPhLabelText();
  if (STUDIO._phTimer) clearInterval(STUDIO._phTimer);
  STUDIO._phTimer = setInterval(studioPhLabelText, 120);
}

function studioStopPhAnimation() {
  if (STUDIO._phTimer) { clearInterval(STUDIO._phTimer); STUDIO._phTimer = 0; }
  const line = $('#stTlPlayheadLine');
  if (line) { line.style.animation = 'none'; line.style.display = 'none'; }
  const cv = $('#stTlPhCanvas');
  if (cv) cv.style.display = 'block';
  studioUpdatePlayhead();
}

function studioUpdatePlayhead() {
  if (STUDIO.tlCollapsed) return;
  // 播放时由 CSS 动画负责，Canvas 只负责暂停/拖动时的静态播放头
  if (STUDIO.playing) { studioStartPhAnimation(); return; }
  const cv = $('#stTlPhCanvas');
  const layer = $('#stTlPlayheadLayer');
  if (!cv || !layer) return;
  const now = performance.now();
  // 播放头用独立 Canvas 绘制：60fps 移动也不会触发布局/样式重算
  // 暂停/手动定位时不限速，保证最终位置立刻画准
  if (STUDIO.playing && now - (STUDIO._phCanvasAt || 0) < 16) return;
  STUDIO._phCanvasAt = now;
  if (STUDIO._phSizeDirty || !STUDIO._phW || !STUDIO._phH) {
    STUDIO._phW = Math.max(1, layer.clientWidth);
    STUDIO._phH = Math.max(1, layer.clientHeight);
    STUDIO._phSizeDirty = false;
    cv.width = STUDIO._phW;
    cv.height = STUDIO._phH;
  }
  const W = STUDIO._phW, H = STUDIO._phH;
  if (cv.width !== W || cv.height !== H) {
    cv.width = W; cv.height = H;
    STUDIO._phFirst = true;
  }
  const ctx = pixelCtx(cv);
  const scale = Math.max(0.001, scaleFactor());
  const raw = STUDIO.t / scale;
  const dur = timelineDuration();
  const scroll = $('#stTlScroll');
  const sx = scroll ? scroll.scrollLeft : 0;
  const x = TL_PAD + Math.max(0, Math.min(dur, raw)) * STUDIO.pps - sx;
  if (x < -20 || x > W + 20) {
    if (!STUDIO._phFirst) {
      ctx.clearRect(0, 0, W, 20);
      if (STUDIO._phLX != null) ctx.clearRect(STUDIO._phLX - 2, 0, 5, H);
      STUDIO._phLX = null;
    }
    return;
  }
  if (STUDIO._phFirst) {
    ctx.clearRect(0, 0, W, H);
    STUDIO._phFirst = false;
  } else {
    // 只擦播放头顶部标签条和上一帧的竖线，避免每帧清空整张画布
    ctx.clearRect(0, 0, W, 20);
    if (STUDIO._phLX != null) ctx.clearRect(STUDIO._phLX - 2, 0, 5, H);
  }
  STUDIO._phLX = x;
  ctx.fillStyle = '#0066cc';
  ctx.fillRect(x - 0.75, 0, 1.5, H);
  ctx.beginPath();
  ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 8); ctx.closePath();
  ctx.fill();
  const txt = raw.toFixed(2) + 's';
  ctx.font = '9px "Microsoft YaHei UI", monospace';
  const tw = Math.ceil(ctx.measureText(txt).width);
  let lx = x + 7;
  if (lx + tw + 9 > W) lx = Math.max(2, x - tw - 9);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(lx, 2, tw + 8, 14);
  ctx.strokeStyle = 'rgba(0,102,204,.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(lx + .5, 2.5, tw + 7, 13);
  ctx.fillStyle = '#0066cc';
  ctx.fillText(txt, lx + 4, 12);
}
function studioRenderTimeline() {
  const stage = $('#stTlStage'), gutter = $('#stTlGutter');
  if (!stage || !gutter) return;
  const scroll = $('#stTlScroll');
  const sx = scroll ? scroll.scrollLeft : 0, sy = scroll ? scroll.scrollTop : 0;
  const dur = timelineDuration();
  const parts = studioCachedParts();
  const pps = STUDIO.pps;
  const vis = Math.max(240, (scroll ? scroll.clientWidth : 600) - 112);
  const stageW = Math.max(vis, Math.round(dur * pps) + TL_PAD * 2 + 28);
  stage.style.width = stageW + 'px';
  const totalH = 24 + parts.length * 26;
  stage.style.height = totalH + 'px';
  gutter.style.height = totalH + 'px';

  gutter.innerHTML = '<div class="tl-gutter-spacer">部件 / 时间</div>' + parts.map(p =>
    '<div class="tl-label" data-part="' + esc(p.id) + '" title="' + esc(p.label) + '">' +
      '<span class="tl-swatch" style="--tc:' + partColor(p.id) + '"></span>' +
      '<span class="tl-pname">' + esc(p.label) + '</span>' +
      '<span class="tl-pkey">' + STUDIO.keys.filter(k => k.part === p.id).length + '</span>' +
    '</div>').join('');

  const step = (() => {
    const opts = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10];
    for (const s of opts) if (s * pps >= 46) return s;
    return 10;
  })();
  let ruler = '';
  for (let t = 0; t <= dur + 0.0001; t += step) {
    const x = TL_PAD + t * pps;
    const label = step < 0.1 ? t.toFixed(2) : step < 1 ? t.toFixed(1) : String(Math.round(t * 10) / 10);
    ruler += '<div class="tl-tick" style="left:' + x + 'px"><i></i><b>' + label + 's</b></div>';
  }
  const rulerEl = $('#stTlRuler');
  if (rulerEl) rulerEl.innerHTML = ruler;

  const tracks = $('#stTlTracks');
  if (tracks) tracks.innerHTML = parts.map(p => {
    const list = STUDIO.keys.filter(k => k.part === p.id);
    return '<div class="tl-track" data-part="' + esc(p.id) + '" style="--tc:' + partColor(p.id) + '">' +
      list.map(k => {
        const sel = k === STUDIO.selKey;
        const eased = k.ease && k.ease !== 'linear';
        const frame = p.kind === 'body' && k.props.frame !== undefined
          ? '<b class="tl-frame">' + esc(String(k.props.frame)) + '</b>' : '';
        return '<div class="tl-dot' + (sel ? ' sel' : '') + (eased ? ' eased' : '') +
          '" style="left:' + (TL_PAD + k.time * pps) + 'px" data-k="' + STUDIO.keys.indexOf(k) +
          '" title="' + esc(fmtTime(k.time) + ' · ' + fmtProps(k.props) + ' · ' + easeLabel(k)) + '">' +
          frame + '</div>';
      }).join('') + '</div>';
  }).join('');
  if (scroll) { scroll.scrollLeft = sx; scroll.scrollTop = sy; }
  const zv = $('#stTlZoomVal');
  if (zv) zv.textContent = Math.round(pps / 120 * 100) + '%';
  studioSyncTimelineSelection();
  studioUpdatePlayhead();
}
function studioSyncTimelineSelection() {
  const part = STUDIO.selKey ? STUDIO.selKey.part : (($('#stPart') || {}).value || 'body');
  $$('.tl-label').forEach(l => l.classList.toggle('active', l.dataset.part === part));
  $$('.tl-track').forEach(t => t.classList.toggle('active', t.dataset.part === part));
}
function studioSeekRaw(raw, pause) {
  if (pause) studioPlay(false);
  raw = Math.max(0, raw);
  STUDIO.t = raw * Math.max(0.001, scaleFactor());
  studioRequestDraw();
}
function studioTimelineSeekPointer(ev) {
  const stage = $('#stTlStage');
  if (!stage) return;
  studioPlay(false);
  STUDIO.dragging = true;
  const rect = stage.getBoundingClientRect();
  const seek = e => {
    const raw = Math.max(0, (e.clientX - rect.left - TL_PAD) / STUDIO.pps);
    studioSeekRaw(raw, false);
  };
  seek(ev);
  const move = e => seek(e);
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    STUDIO.dragging = false;
    studioDrawOnly();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
function studioBeginKeyDrag(ev, k) {
  if (!k) return;
  ev.preventDefault();
  ev.stopPropagation();
  studioPlay(false);
  STUDIO.selKey = k;
  STUDIO.dragging = true;
  studioRefreshPartPreview();
  const dot = ev.target.closest ? ev.target.closest('.tl-dot') : null;
  if (dot) {
    dot.classList.add('sel');
    dot.style.willChange = 'transform';
    dot.style.left = '0px';
    dot.style.transform = 'translateX(' + (TL_PAD + k.time * STUDIO.pps) + 'px)';
  }
  const startX = ev.clientX;
  const startTime = k.time;
  let moved = false;
  // 拖动过程中只移动当前圆点 + 请求重绘画布，不重建整条时间轴
  const move = e => {
    const nt = studioSnapTime(startTime + (e.clientX - startX) / STUDIO.pps);
    if (Math.abs(nt - k.time) > 0.0001) moved = true;
    k.time = nt;
    if ($('#stKTime')) $('#stKTime').value = +(Math.round(nt * 1000) / 1000);
    STUDIO.t = nt * Math.max(0.001, scaleFactor());
    if (dot) dot.style.transform = 'translateX(' + (TL_PAD + nt * STUDIO.pps) + 'px)';
    studioRequestDraw();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (STUDIO._drawRaf) { cancelAnimationFrame(STUDIO._drawRaf); STUDIO._drawRaf = 0; }
    STUDIO.dragging = false;
    STUDIO.keys.sort((a, b) => a.time - b.time || partOrder(a.part) - partOrder(b.part));
    studioRefreshAll();
    if (moved) toast('关键帧已移到 ' + fmtTime(k.time), 'ok', 1800);
    else studioLoadKey(k);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
function studioTimelineAdd() {
  const raw = studioSnapTime(STUDIO.t / Math.max(0.001, scaleFactor()));
  $('#stKTime').value = +(Math.round(raw * 1000) / 1000);
  const part = $('#stPart').value || 'body';
  let has = false;
  $$('#stProps [data-prop]').forEach(inp => { if (String(inp.value || '').trim() !== '') has = true; });
  if (!has) {
    const sample = samplePartFrom(STUDIO.keys, 1, part, raw);
    if (sample) {
      $$('#stProps [data-prop]').forEach(inp => {
        if (sample[inp.dataset.prop] !== undefined) inp.value = sample[inp.dataset.prop];
      });
    }
  }
  studioAddKey();
}
function studioDeleteSelectedKey() {
  if (!STUDIO.selKey) return false;
  const i = STUDIO.keys.indexOf(STUDIO.selKey);
  if (i < 0) return false;
  STUDIO.keys.splice(i, 1);
  STUDIO.selKey = null;
  studioRefreshAll();
  toast('已删除关键帧', 'ok', 1600);
  return true;
}

function studioKeydown(ev) {
  const studio = $('#studio');
  if (!studio || studio.classList.contains('hidden')) return;
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
    const k = String(ev.key || '').toLowerCase();
    if (k === 'z' || k === 'y') {
      if ($('#modalMask') && !$('#modalMask').classList.contains('hidden')) return;
      ev.preventDefault();
      if (k === 'y' || ev.shiftKey) studioRedo();
      else studioUndo();
      return;
    }
  }
  const tag = (ev.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' ||
      ev.target.isContentEditable) return;
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if (studioDeleteSelectedKey()) ev.preventDefault();
  } else if (ev.key === ' ') {
    studioPlay(!STUDIO.playing);
    ev.preventDefault();
  } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    studioPlay(false);
    const d = ev.shiftKey ? 0.5 : 0.05;
    studioSeekRaw(STUDIO.t / Math.max(0.001, scaleFactor()) + (ev.key === 'ArrowRight' ? d : -d), false);
    ev.preventDefault();
  } else if (ev.key === 'Escape') {
    closeStudio();
  }
}

/* ---------------- 帧动画 ---------------- */
function bodyFrameInfo() {
  const g = firstSecMap('graphics') || {};
  if (!g.image) return { ok: false, g: g, msg: '当前单位没有 [graphics] image，无法读取帧。' };
  const sp = animSprite(g.image);
  if (!sp || sp.kind !== 'file') {
    if (sp && sp.kind && sp.kind !== 'loading') {
      return { ok: false, g: g, msg: '主体贴图是内置 / 共享素材（' + sp.kind + '），无法读取本地帧。' };
    }
    return { ok: false, loading: true, g: g, msg: '贴图读取中…' };
  }
  if (sp.state !== 'ok' || !sp.img) {
    return { ok: false, loading: sp.state !== 'err', g: g, msg: sp.state === 'err' ? '贴图加载失败：' + g.image : '贴图读取中…' };
  }
  return { ok: true, img: sp.img, spec: frameSplitSpec(sp.img, g), g: g };
}
function studioRefreshFrames() {
  const strip = $('#stFrameStrip');
  if (!strip) return;
  const info = bodyFrameInfo();
  const meta = $('#stFrameMeta');
  if (!info.ok) {
    strip.innerHTML = '<div class="frame-empty">' + esc(info.msg) + '</div>';
    if (meta) meta.textContent = info.loading ? '读取中…' : '不可用';
    if (info.loading) {
      STUDIO._frameTries = (STUDIO._frameTries || 0) + 1;
      if (STUDIO._frameTries < 20) setTimeout(() => {
        if (STUDIO.stTab === 'frames' && $('#studio') && !$('#studio').classList.contains('hidden')) studioRefreshFrames();
      }, 500);
    }
    return;
  }
  STUDIO._frameTries = 0;
  const spec = info.spec;
  if (meta) meta.textContent = spec.count + ' 帧 · 单帧 ' + spec.fw + '×' + spec.fh + ' · ' + spec.cols + ' 列';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < spec.count; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'frame-cell';
    cell.dataset.frame = i;
    cell.title = '第 ' + i + ' 帧 · 点击插入到播放头';
    const cv = document.createElement('canvas');
    cv.width = 46; cv.height = 46;
    const ctx = pixelCtx(cv);
    const sc = Math.min(46 / spec.fw, 46 / spec.fh);
    const dw = Math.max(1, spec.fw * sc), dh = Math.max(1, spec.fh * sc);
    const sx = (i % spec.cols) * spec.fw;
    const sy = Math.floor(i / spec.cols) * spec.fh;
    ctx.imageSmoothingEnabled = false;
    try { ctx.drawImage(info.img, sx, sy, spec.fw, spec.fh, (46 - dw) / 2, (46 - dh) / 2, dw, dh); } catch (e) { /* 越界 */ }
    const num = document.createElement('span');
    num.textContent = i;
    cell.appendChild(cv);
    cell.appendChild(num);
    frag.appendChild(cell);
  }
  strip.innerHTML = '';
  strip.appendChild(frag);
  const seq = $('#stFrameSeq');
  if (seq && !seq.value.trim()) seq.value = spec.count > 1 ? '0-' + (spec.count - 1) : '0';
  strip.onclick = ev => {
    const cell = ev.target.closest('[data-frame]');
    if (!cell) return;
    studioInsertFrame(parseInt(cell.dataset.frame, 10), spec, info.img);
  };
}
function parseFrameSeq(text, count) {
  const out = [];
  String(text || '').split(/[,，;；\s]+/).filter(Boolean).forEach(tok => {
    const m = tok.match(/^(-?\d+)\s*[-~]\s*(-?\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      const step = a <= b ? 1 : -1;
      for (let i = a; step > 0 ? i <= b : i >= b; i += step) {
        if (i >= 0 && i < count) out.push(i);
      }
    } else {
      const n = parseInt(tok, 10);
      if (isFinite(n) && n >= 0 && n < count) out.push(n);
    }
  });
  return out;
}
function studioInsertFrame(frame, spec, img) {
  const raw = studioSnapTime(STUDIO.t / Math.max(0.001, scaleFactor()));
  const base = samplePartFrom(STUDIO.keys, 1, 'body', raw) || {};
  const props = Object.assign({}, base, { frame: frame });
  const i = STUDIO.keys.findIndex(k => k.part === 'body' && Math.abs(k.time - raw) < 0.0001);
  let key;
  if (i >= 0) {
    key = STUDIO.keys[i];
    key.props = Object.assign({}, key.props, props);
    key.ease = 'linear';
    key.bezier = undefined;
  } else {
    key = { time: raw, part: 'body', props: props, ease: 'linear' };
    STUDIO.keys.push(key);
  }
  STUDIO.selKey = key;
  if ($('#stPart')) $('#stPart').value = 'body';
  STUDIO.keys.sort((a, b) => a.time - b.time || partOrder(a.part) - partOrder(b.part));
  studioRefreshAll();
  toast('已插入第 ' + frame + ' 帧 @ ' + fmtTime(raw), 'ok', 1800);
}
function studioGenerateFrames() {
  const info = bodyFrameInfo();
  if (!info.ok) { toast(info.msg || '读不到主体贴图帧', 'err', 3600); return; }
  const spec = info.spec;
  let seq = parseFrameSeq($('#stFrameSeq').value, spec.count);
  if (!seq.length) { toast('序列要填 0-' + (spec.count - 1) + ' 这样的范围，或 0,1,2 列表', 'err', 3600); return; }
  const fps = parseFloat($('#stFrameFps').value);
  if (!isFinite(fps) || fps <= 0 || fps > 120) { toast('帧率要填 0.1~120 之间的数字', 'err'); return; }
  const start = parseFloat($('#stFrameStart').value);
  if (!isFinite(start) || start < 0) { toast('开始时间要填不小于 0 的数字', 'err'); return; }
  if ($('#stFramePP').checked && seq.length > 1) {
    seq = seq.concat(seq.slice(1, -1).reverse());   // 0,1,2,3 → 0,1,2,3,2,1
  }
  const times = seq.map((f, i) => start + i / fps);
  const end = times[times.length - 1];
  const overlap = STUDIO.keys.filter(k => k.part === 'body' && k.time >= start - 0.0001 && k.time <= end + 0.0001);
  if (overlap.length && !confirm('这段时间里已有 ' + overlap.length + ' 个主体关键帧，生成帧动画会替换它们，继续吗？')) return;
  // 先采样原来的主体属性，保留 frame 以外的 scale 等属性
  const baseAt = times.map(t => samplePartFrom(STUDIO.keys.filter(k => k.part === 'body'), 1, 'body', t) || {});
  STUDIO.keys = STUDIO.keys.filter(k => !(k.part === 'body' && k.time >= start - 0.0001 && k.time <= end + 0.0001));
  const made = [];
  times.forEach((t, i) => {
    const props = Object.assign({}, baseAt[i], { frame: seq[i] });
    const k = { time: t, part: 'body', props: props, ease: 'linear' };
    STUDIO.keys.push(k);
    made.push(k);
  });
  STUDIO.keys.sort((a, b) => a.time - b.time || partOrder(a.part) - partOrder(b.part));
  STUDIO.selKey = made[0] || null;
  if ($('#stPart')) $('#stPart').value = 'body';
  STUDIO.t = start * Math.max(0.001, scaleFactor());
  studioRefreshAll();
  toast('已生成 ' + made.length + ' 帧（' + fmtTime(start) + ' → ' + fmtTime(end) + '，' + fps + ' fps）', 'ok', 4200);
}

function studioRefreshLists() {
  const docAnims = S.doc.sections.filter(s => deriveSecId(s.name) === 'animation');
  $('#stLoadDoc').innerHTML = docAnims.map(s =>
    '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>').join('') ||
    '<option value="">（当前文件没有动画段）</option>';
  const bagAnims = S.bag.filter(it => it.kind === 'section' && /^animation_/i.test(String((it.payload || {}).name || it.name)));
  $('#stLoadBag').innerHTML = bagAnims.map(it =>
    '<option value="' + esc(it.id) + '">' + esc(it.name) + '</option>').join('') ||
    '<option value="">（背包里没有动画模块）</option>';
  const prev = $('#stPart').value;
  const parts = studioCachedParts();
  $('#stPart').innerHTML = parts.map(p => '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>').join('');
  if (prev && parts.some(p => p.id === prev)) $('#stPart').value = prev;
  studioRefreshProps();
}

function studioRefreshAll() {
  $('#stName').value = STUDIO.name;
  $('#stOnActions').value = STUDIO.params.onActions || '';
  $('#stBlendIn').value = STUDIO.params.blendIn || '';
  $('#stBlendOut').value = STUDIO.params.blendOut || '';
  $('#stScale').value = STUDIO.params.KeyframeTimeScale || '';
  $('#stRate').value = STUDIO.params.playbackRate || '';
  $('#stPingPong').checked = /^true$/i.test(STUDIO.params.pingPong || '');
  if ($('#stBake')) $('#stBake').checked = STUDIO.bake !== false;
  if ($('#stBakeStep')) $('#stBakeStep').value = STUDIO.bakeStep;
  if ($('#stGrid')) $('#stGrid').value = STUDIO.grid;
  if ($('#stTlSnap')) $('#stTlSnap').checked = !!STUDIO.snap;
  updateStudioSrcHint();
  studioRefreshLists();
  // refreshLists 会重建空表单；把当前选中帧的 x/y/dir/alpha 重新填回，避免下一次“更新”把它们清掉
  if (STUDIO.selKey) studioFillFormFromKey(STUDIO.selKey);
  studioRenderKeys();
  studioApplyFormState();
  studioRenderTimeline();
  studioSetTab(STUDIO.stTab || 'keys');
  if (STUDIO.stTab === 'code') studioRenderCodeView();
  studioDrawOnly();
  studioRefreshPartPreview();
  if ($('#stTlToggle')) $('#stTlToggle').textContent = STUDIO.tlCollapsed ? '展开' : '收起';
  $('#stTimeline') && $('#stTimeline').classList.toggle('collapsed', !!STUDIO.tlCollapsed);
  if (STUDIO.selKey) studioLoadEaseForm(STUDIO.selKey);
  studioHistoryCommit();
}

function studioCollectParams() {
  STUDIO.name = ($('#stName').value || 'animation_1').trim().replace(/^\[|\]$/g, '');
  STUDIO.params.onActions = $('#stOnActions').value;
  STUDIO.params.blendIn = $('#stBlendIn').value.trim();
  STUDIO.params.blendOut = $('#stBlendOut').value.trim();
  STUDIO.params.KeyframeTimeScale = $('#stScale').value.trim();
  STUDIO.params.playbackRate = $('#stRate').value.trim();
  STUDIO.params.pingPong = $('#stPingPong').checked ? 'true' : 'false';
}

/* ---- 播放循环 ---- */
function studioPlay(on) {
  STUDIO.playing = !!on;
  const b = $('#stPlay');
  if (b) b.textContent = STUDIO.playing ? '⏸ 暂停' : '▶ 播放';
  if (STUDIO.playing) studioStartPhAnimation();
  else studioStopPhAnimation();
  if (STUDIO.playing && !STUDIO.raf) {
    STUDIO.last = performance.now();
    const step = t => {
      const dt = Math.min(0.1, (t - STUDIO.last) / 1000);
      STUDIO.last = t;
      const dur = studioDuration();
      if (STUDIO.playing) {
        STUDIO.t += dt * STUDIO.speed;
        if (STUDIO.t > dur) {
          if (STUDIO.loop) STUDIO.t = 0;
          else { STUDIO.t = dur; studioPlay(false); }
        }
      }
      // 播放画布不限制帧率，跟随显示器刷新率
      studioDrawOnly(false);
      STUDIO.raf = requestAnimationFrame(step);
    };
    STUDIO.raf = requestAnimationFrame(step);
  } else if (!STUDIO.playing) {
    // 循环里会自己停（性能更好：停掉 rAF）
    if (STUDIO.raf) { cancelAnimationFrame(STUDIO.raf); STUDIO.raf = 0; }
    const st = $('#studio');
    if (st && !st.classList.contains('hidden')) studioDrawOnly();
  }
}

const PREVIEW_MAX_DUR = 30;      // 超过 30s（常见于 99999s 的“保持”帧）按 5s 循环预览
function studioDuration() {
  const manual = parseFloat($('#stDur') && $('#stDur').value);
  if (isFinite(manual) && manual > 0) return manual;
  const full = animDuration();
  if (full > PREVIEW_MAX_DUR) {
    const hint = $('#stFootHint');
    if (hint) hint.innerHTML = '这段动画总时长 ' + full.toFixed(1) +
      's（常见于“保持”帧），预览按 5s 循环；要完整看请在「时长」里填数字';
    return 5;
  }
  return full;
}

function studioRequestDraw() {
  if (STUDIO._drawRaf) return;
  STUDIO._drawRaf = requestAnimationFrame(() => {
    STUDIO._drawRaf = 0;
    studioDrawOnly(false);
  });
}

function studioDrawOnly(collectParams) {
  if (collectParams !== false) studioCollectParams();
  const cv = $('#stCanvas');
  if (!cv) return;
  // 画布尺寸只在窗口/时间轴布局变化时读一次，避免每帧强制同步布局
  if (STUDIO._sizeDirty || !STUDIO._cw || !STUDIO._ch) {
    const box = cv.parentElement;
    STUDIO._cw = Math.max(280, Math.floor(cv.clientWidth || 620));
    STUDIO._ch = Math.max(180, Math.floor(box.clientHeight - 110) || 400);
    STUDIO._sizeDirty = false;
  }
  const w = STUDIO._cw, h = STUDIO._ch;
  // 播放/拖时间轴时用 1x 画布，暂停后再恢复高清；视觉略软但能明显减负
  const low = !!(STUDIO.playing || STUDIO.dragging);
  const dpr = low ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
  }
  const ctx = pixelCtx(cv, { alpha: false, desynchronized: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dur = studioDuration();
  if (STUDIO.t > dur) STUDIO.t = dur;
  const highlightPart = STUDIO.selKey ? STUDIO.selKey.part : (($('#stPart') || {}).value || 'body');
  let selectedEffectName = '';
  if (highlightPart === 'effect') {
    if (STUDIO.selKey && STUDIO.selKey.part === 'effect') selectedEffectName = String((STUDIO.selKey.props || {}).name || '');
    else { const ns = $('#stProps [data-prop="name"]'); selectedEffectName = ns ? String(ns.value || '') : ''; }
  }
  STUDIO._drawW = w; STUDIO._drawH = h;
  STUDIO._positions = {};
  const readout = drawAnimFrame(ctx, w, h, STUDIO.keys, scaleFactor(), STUDIO.t,
    { tMs: performance.now(), highlightPart: highlightPart, selectedEffectName: selectedEffectName,
      parts: studioCachedParts(), positions: STUDIO._positions, showHandles: !STUDIO.playing,
      zoom: STUDIO.zoom, panX: STUDIO.panX, panY: STUDIO.panY });
  const now = performance.now();
  const uiTick = (!STUDIO.playing && !STUDIO.dragging) ||
    now - (STUDIO._uiAt || 0) > (STUDIO.dragging ? 120 : 150);
  if (uiTick) {
    STUDIO._uiAt = now;
    const sl = $('#stTime');
    if (sl) { sl.max = Math.round(dur * 1000); sl.value = Math.round(STUDIO.t * 1000); }
    const tt = $('#stTimeTxt');
    if (tt) tt.textContent = STUDIO.t.toFixed(2) + 's / ' + dur.toFixed(2) + 's';
    const ro = $('#stReadout');
    if (ro) ro.innerHTML = readout.length
      ? readout.map(r => '<span>' + esc(r) + '</span>').join('')
      : '<span class="hint">还没有关键帧 —— 加几个就能看到动作</span>';
  }
  if (!STUDIO.playing) studioUpdatePlayhead();
}

/* ---- 写入代码 ---- */
function studioWrite() {
  studioCollectParams();
  if (!STUDIO.keys.length) {
    if (!confirm('还没有关键帧，仍然要写入这个空动画段吗？')) return;
  }
  const entries = studioEntries();
  const outKeys = entries.filter(e => KEY_RE.test(e.key)).length;
  let sec = S.doc.sections.find(s => s.name === STUDIO.name);
  const isNew = !sec;
  if (!sec) {
    sec = newSection(STUDIO.name);
    sec.entries = entries.map(e => newEntry(e.key, e.value));
    S.doc.sections.push(sec);
  } else {
    // 已有同名段：覆盖它的字段（保留其它不认识的行）
    const keepRaw = sec.entries.filter(e => e.kind === 'raw');
    sec.entries = entries.map(e => newEntry(e.key, e.value)).concat(keepRaw);
  }
  S.ui.activeSection = sec.id;
  markDirty(); renderAll();
  saveStudioSource(sec);
  if ($('#studio') && !$('#studio').classList.contains('hidden')) studioRefreshLists();
  toast((isNew ? '已新增 ' : '已更新 ') + '<b>[' + esc(STUDIO.name) + ']</b>，源关键帧 ' +
    STUDIO.keys.length + ' 个' + (outKeys !== STUDIO.keys.length ? '，烘焙后写入 ' + outKeys + ' 个' : '') +
    (isNew ? '' : '（原来的字段被覆盖）'), 'ok', 4400);
}

/* ---- 效果预览里的动画卡片（由 app.js 调用） ---- */
function renderAnimCards() {
  const box = $('#fxAnims');
  if (!box) return;
  const anims = S.doc.sections.filter(s => deriveSecId(s.name) === 'animation');
  if (!anims.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="fx-eff-head">动画 <span class="cnt">本文件 ' + anims.length + ' 个</span>' +
    '<span class="grow"></span><button class="btn small primary" id="fxNewAnim">🎬 做新动画</button></div>' +
    '<div class="fx-grid-eff">' + anims.map((s, i) =>
      '<div class="eff-card anim" data-anim="' + i + '" title="' + esc(s.name) + ' · 点击进动画制作器编辑">' +
      '<div class="ec-name">' + esc(s.name) + '</div>' +
      '<canvas class="ec-canvas" data-animcanvas="' + i + '" width="300" height="152"></canvas>' +
      '<div class="ec-kv"><em>' + esc(animSummary(s)) + '</em></div>' +
      '<div class="ec-bad" style="color:var(--green)">点击编辑 / 预览</div>' +
      '</div>').join('') + '</div>';
  $('#fxNewAnim').onclick = () => openStudio(null);
  const t0 = performance.now();
  anims.forEach((s, i) => {
    const cv = box.querySelector('[data-animcanvas="' + i + '"]');
    if (!cv) return;
    const parsed = parseAnimSection(s);
    const sc = timeScaleOf(parsed.params);
    const dur = Math.min(5, Math.max(0.2, parsed.keys.reduce((a, k) => Math.max(a, k.time), 0) * sc));
    animAdd(t => {
      if (!cv.isConnected) return;
      const ctx = pixelCtx(cv);
      const tt = ((t - t0) / 1000) % dur;
      drawAnimFrame(ctx, cv.width, cv.height, parsed.keys, sc, tt,
        { tMs: t, showReadout: false, scale: 0.75 });
    });
  });
  animRun();
  box.onclick = ev => {
    const card = ev.target.closest('[data-anim]');
    if (!card) return;
    const s = anims[parseInt(card.dataset.anim, 10)];
    if (s) openStudio(s.name);
  };
}

function animSummary(sec) {
  const p = parseAnimSection(sec);
  const parts = {};
  p.keys.forEach(k => { parts[k.part.replace(/\d+$/, '')] = (parts[k.part.replace(/\d+$/, '')] || 0) + 1; });
  const bits = [];
  if (p.params.onActions) bits.push('条件 ' + p.params.onActions);
  bits.push(p.keys.length + ' 个关键帧');
  const pt = Object.keys(parts).map(k => ({ body: '主体', turret: '炮塔', leg: '腿', arm: '胳膊', effect: '特效' })[k] + parts[k]);
  if (pt.length) bits.push(pt.join(' '));
  if (parseFloat(p.params.KeyframeTimeScale) > 0) bits.push('时长×' + p.params.KeyframeTimeScale);
  if (/^true$/i.test(p.params.pingPong || '')) bits.push('往返');
  return bits.join('　');
}
