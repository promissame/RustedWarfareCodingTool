/* ============================================================
   铁锈代码编写器 —— 前端逻辑
   图形化编写 · 实时预览 · 自动纠错
   ============================================================ */
'use strict';

/* ---------------- 小工具 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
/** 统一创建 2D 画布：像素游戏全项目禁用图像平滑 */
function pixelCtx(cv, opts) {
  const ctx = cv.getContext('2d', opts);
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    try { ctx.imageSmoothingQuality = 'low'; } catch (e) { /* 旧浏览器忽略 */ }
  }
  return ctx;
}
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
let _uid = 1;
const uid = p => (p || 'id') + '_' + (_uid++);

function toast(msg, kind = '', ms = 2600) {
  const d = document.createElement('div');
  d.className = 'toast ' + kind;
  d.innerHTML = msg;
  $('#toastWrap').appendChild(d);
  setTimeout(() => { d.style.transition = '.3s'; d.style.opacity = '0'; d.style.transform = 'translateX(30px)'; }, ms - 300);
  setTimeout(() => d.remove(), ms);
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------------- 全局状态 ---------------- */
const S = {
  meta: null,
  byId: {},          // sectionId -> meta section
  globalKeys: {},    // code -> [{secId, entry}]
  doc: {
    path: null, name: '未命名.ini', dirty: false,
    sections: []     // {id, name, comment, collapsed, entries:[{id,key,value,raw,comment,collapsed}]}
  },
  ui: {
    tab: 'code', scope: 'all', search: '', activeSection: null,
    issues: [], closedLib: {}, lastFocus: null,
    auditTab: 'assets', scanning: false, _miss: null, side: 'lib', fsLoading: false, mview: 'edit',
    canvasZoom: 1, canvasPan: { x: 0, y: 0 }, canvasPath: null, baseScale: 1,
    fieldFilter: '', _filterDocPath: null,
    fxState: (() => { try { return localStorage.getItem('rt_fx_state') === 'dead' ? 'dead' : 'normal'; } catch (e) { return 'normal'; } })(),
    fsSort: 'name-asc', fsView: 'list', fsSelect: false, fsMulti: new Set(), fsAnchor: null,
    leftW: 296, rightW: 420, sidebarOpen: true, _layoutSaved: false
  },
  bag: [],        // 背包模块
  bagSel: [],     // 当前勾选要存进背包的键
  scan: null,     // 模组扫描结果
  fs: { path: '', parent: '', name: '', dirs: [], files: [], modRoot: '', sel: null },
  modRoot: ''
};

/* ============================================================
   1. 代码表索引
   ============================================================ */
function buildIndex() {
  S.byId = {}; S.globalKeys = {};
  for (const sec of S.meta.sections) {
    S.byId[sec.id] = sec;
    for (const g of sec.groups) {
      for (const e of g.entries) {
        e._secId = sec.id; e._grp = g.name;
        (S.globalKeys[e.code] = S.globalKeys[e.code] || []).push({ secId: sec.id, entry: e });
      }
    }
  }
  // 段序号（用于代码表顺序 / 整理排序）
  let i = 0;
  for (const sec of S.meta.sections) for (const g of sec.groups) for (const e of g.entries) e._order = i++;
  // 段名前缀表（长前缀优先），用于识别 [turret_1] / [effect_爆炸] 这类段
  SEC_PREFIXES = S.meta.sections.map(s => s.id).filter(id => id !== 'leg_#')
    .concat(['leg', 'arm', 'hiddenAction']).sort((a, b) => b.length - a.length);
}
let SEC_PREFIXES = [];

function deriveSecId(name) {
  const n = String(name || '').trim().replace(/^\[/, '').replace(/\]$/, '');
  if (S.byId[n]) return n;
  const low = n.toLowerCase();
  for (const p of SEC_PREFIXES) {
    const pl = p.toLowerCase();
    if (low === pl) return mapPrefix(p);
    if (low.startsWith(pl + '_')) return mapPrefix(p);
  }
  // 兜底：取开头的英文
  const m = n.match(/^([A-Za-z_#]+)/);
  if (!m) return n;
  let id = m[1].replace(/_+$/, '').replace(/_?NAME$/, '');
  return mapPrefix(id);
}
function mapPrefix(p) {
  if (p === 'hiddenAction') return 'action';
  if (p === 'arm' || p === 'leg') return 'leg_#';
  return p;
}

/* 代码表里的占位符键（mutatorX_ / leg#_ / animation_TYPE_ / displayText_[Language]）→ 正则 */
const _keyReCache = {};
function metaKeyRe(code) {
  if (_keyReCache[code]) return _keyReCache[code];
  let s = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  s = s.replace(/\\\[[^\]]*\\\]/g, '[A-Za-z0-9_.\\-]*').replace(/#/g, '\\d*').replace(/\d+/g, '\\d*')
       .replace(/[A-Z]{2,}/g, '[A-Za-z0-9_.\\-]*');
  const re = new RegExp('^' + s + '$', 'i');
  _keyReCache[code] = re;
  return re;
}
function normWild(s) {
  return String(s).replace(/\[[^\]]*\]/g, '#').replace(/\d+/g, 'X')
    .replace(/[A-Z]{2,}/g, '#').replace(/#/g, 'X');
}
function findKeyMeta(code) {
  if (S.globalKeys[code]) return S.globalKeys[code];
  const nw = normWild(code);
  for (const k in S.globalKeys) {
    if (metaKeyRe(k).test(code) || normWild(k) === nw) return S.globalKeys[k];
  }
  return null;
}
function fieldMeta(secId, key) {
  const s = S.byId[secId];
  if (!s) return null;
  for (const g of s.groups) for (const e of g.entries) if (e.code === key) return e;
  // 占位符键（mutatorX_ / leg#_ / displayText_[Language]）模糊匹配
  for (const g of s.groups) for (const e of g.entries) {
    if (/[X#\[]/.test(e.code) && (metaKeyRe(e.code).test(key) || normWild(e.code) === normWild(key))) return e;
  }
  return null;
}
/* 代码表用占位符登记的键（mutatorX_xxx 这类），类型提示放宽为“提示”而不是“警告” */
function isWildKey(fm) { return !!(fm && /[X#\[]/.test(fm.code)); }

/* 这些段共用同一批字段（代码表分开登记，实际可以混着用） */
const SEC_SIBLINGS = { resource: ['global_resource'], global_resource: ['resource'],
  attack: ['turret'], turret: ['attack'] };
function fieldMetaLoose(secId, key) {
  const m = fieldMeta(secId, key);
  if (m) return m;
  for (const sib of (SEC_SIBLINGS[secId] || [])) {
    const m2 = fieldMeta(sib, key);
    if (m2) return m2;
  }
  return null;
}
/* RW 允许在这些数字键里写表达式，例如 alpha: max(0, sin(...))、price: 8000,蓝晶=2100 */
const NUM_RE = /^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/;
function isNumber(v) { return NUM_RE.test(String(v).trim()); }
function looksLikeExpr(v) {
  const t = String(v).trim();
  if (!t) return false;
  if (/^\$/.test(t)) return true;
  if (/\bself\.|\bmemory\.|\beventSource|\bthisAction|\bthisUnit/.test(t)) return true;
  if (/^\s*(if|select|max|min|abs|sin|cos|tan|floor|ceil|round|clamp|sqrt|pow|random)\s*\(/i.test(t)) return true;
  if (/[A-Za-z_)]\s*[-+*/<>]=?\s*[-\d(]/.test(t)) return true;
  if (/^[A-Za-z_][\w.]*\s*=/.test(t)) return true;                    // energy=4
  if (t.includes('=') && !/[^\w\s.,=\-+\u4e00-\u9fff%]/.test(t)) return true;   // 8000,蓝晶=2100
  return false;
}
/* 值看起来是资源/特效/图片引用（有些布尔键也允许填这些） */
function looksLikeAsset(v) {
  return /^(CUSTOM:|ROOT:|shared|AUTO$|NONE$)/i.test(String(v).trim()) || /\.(png|jpg|ogg|wav)$/i.test(String(v).trim());
}
function enumOf(kind) {
  if (kind && kind.startsWith('enum:')) return S.meta.enums[kind.slice(5)] || null;
  return null;
}

/* ============================================================
   2. 解析 / 序列化
   ============================================================ */
function newSection(name, opts = {}) {
  return { id: uid('sec'), name: name, comment: '', collapsed: !!opts.collapsed, entries: [] };
}
function newEntry(key, value, opts = {}) {
  return { id: uid('f'), key: key, value: value == null ? '' : String(value),
           raw: opts.raw || null, comment: opts.comment || '', kind: opts.kind || 'field' };
}

/** 旧数据/旧版开关可能写成 on/off；bool 字段统一成 true/false */
function normalizeBoolEntries(sections) {
  for (const sec of sections) {
    const sid = deriveSecId(sec.name);
    for (const e of sec.entries) {
      if (e.kind === 'raw' || !e.key) continue;
      const fm = fieldMeta(sid, e.key) || (findKeyMeta(e.key) || [])[0]?.entry || null;
      if (!fm || fm.kind !== 'bool') continue;
      const low = String(e.value == null ? '' : e.value).trim().toLowerCase();
      if (low === 'on' || low === 'yes') e.value = 'true';
      else if (low === 'off' || low === 'no') e.value = 'false';
    }
  }
}

function parseIni(text) {
  const sections = [];
  let cur = null;
  if (text == null) text = '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let pendingComment = [];
  for (const line of lines) {
    const raw = line;
    const t = line.trim();
    if (!t) { pendingComment = []; continue; }
    if (/^[#;]/.test(t)) { pendingComment.push(t.replace(/^[#;]\s?/, '')); continue; }
    let m = t.match(/^\[(.+)\]$/);
    if (m) { cur = newSection(m[1]); cur.comment = pendingComment.join(' / '); pendingComment = []; sections.push(cur); continue; }
    if (!cur) { cur = newSection('core'); sections.push(cur); }
    // 同时兼容英文冒号与中文冒号（中文冒号会被标成错误但能识别出来）
    m = t.match(/^([^:：\n]{1,60}?)\s*([:：=])\s*([\s\S]*)$/);
    if (m) {
      const e = newEntry(m[1], m[3], { comment: pendingComment.join(' / ') });
      if (m[2] === '：') e.cnColon = true;
      cur.entries.push(e);
      pendingComment = [];
      continue;
    }
    // @memory 之类或无法识别的行，原样保留
    cur.entries.push({ id: uid('r'), key: '', value: t, raw: t, comment: pendingComment.join(' / '), kind: 'raw' });
    pendingComment = [];
  }
  normalizeBoolEntries(sections);
  return sections;
}

function serialize(doc, opts = {}) {
  const blank = opts.blank !== false;
  const withComment = !!opts.comment;
  const out = [];
  doc.sections.forEach((sec, si) => {
    if (si > 0 && blank) out.push('');
    if (sec.comment) out.push('# ' + sec.comment);
    out.push('[' + sec.name + ']');
    for (const e of sec.entries) {
      if (e.kind === 'raw') { if (e.value.trim()) out.push(e.value.trim()); continue; }
      if (e.comment) out.push('# ' + e.comment);
      if (withComment) {
        const fm = fieldMeta(deriveSecId(sec.name), e.key);
        if (fm && fm.trans) out.push('# ' + fm.trans + (fm.vtype ? '  <' + fm.vtype + '>' : ''));
      }
      out.push(e.key + ': ' + e.value);
    }
  });
  return out.join('\n').trimEnd() + '\n';
}

/* ============================================================
   3. 文档操作
   ============================================================ */
function secOf(secId) { return S.doc.sections.filter(s => deriveSecId(s.name) === secId); }

function targetSection(secId, createName) {
  if (S.ui.activeSection) {
    const a = S.doc.sections.find(s => s.id === S.ui.activeSection);
    if (a && deriveSecId(a.name) === secId) return a;
  }
  const found = secOf(secId);
  if (found.length) return found[found.length - 1];
  // 新建
  const meta = S.byId[secId];
  const name = createName || defaultSectionName(secId);
  const s = newSection(name);
  S.doc.sections.push(s);
  S.ui.activeSection = s.id;
  return s;
}

const INDEXED_SECTIONS = {
  turret: 31, projectile: 99, attachment: 9, effect: 9, animation: 9,
  canBuild: 99, decal: 9, comment: 9, template: 9, leg: 20
};
function defaultSectionName(secId) {
  const base = { core: 'core', graphics: 'graphics', attack: 'attack', movement: 'movement',
    ai: 'ai', mod: 'mod', music: 'music', action: 'action_新动作',
    global_resource: 'global_resource_资源名', resource: 'resource_资源名',
    placementRule: 'placementRule_规则名' }[secId];
  if (base) return base;
  const existing = secOf(secId).map(s => {
    const m = String(s.name).match(/(\d+)\s*$/); return m ? parseInt(m[1], 10) : 0;
  });
  const next = (existing.length ? Math.max(...existing) : 0) + 1;
  const prefix = { 'leg_#': 'leg', turret: 'turret', projectile: 'projectile' }[secId] || secId;
  return prefix + '_' + next;
}

function addField(secId, key, value) {
  const before = S.doc.sections.slice();
  const sec = targetSection(secId);
  const isNew = !before.includes(sec);
  const fm = fieldMeta(deriveSecId(sec.name), key) || (findKeyMeta(key) || [])[0]?.entry || null;
  if (!sec.entries.some(e => e.key === key)) {
    const v = value != null ? value : suggestValue(fm);
    sec.entries.push(newEntry(key, v));
    const others = secOf(secId).length;
    toast('' + esc(key) + ' → 已加入 <b>[' + esc(sec.name) + ']</b>' +
      (isNew ? '（新建了这个段）' : '') +
      (others > 1 ? '<br><span style="color:var(--txt3)">这类段有 ' + others + ' 个，想加到别的段：先点那张卡片再添加</span>' : ''),
      'ok', others > 1 || isNew ? 4200 : 2200);
  } else {
    toast('[' + esc(sec.name) + '] 里已经有 <b>' + esc(key) + '</b> 了', 'err');
  }
  markDirty(); renderAll();
  setTimeout(() => focusField(sec.id, key), 30);
}

/** 高亮“当前段”，让用户知道新字段会加到哪儿 */
function highlightActiveSection() {
  $$('#editor .sec-card').forEach(c => {
    const on = c.dataset.sid === S.ui.activeSection;
    c.classList.toggle('active-sec', on);
    const head = c.querySelector('.sec-head');
    if (!head) return;
    let tag = head.querySelector('.cur-tag');
    if (on && !tag) {
      tag = document.createElement('span');
      tag.className = 'cur-tag';
      tag.textContent = '当前段·新字段加这里';
      tag.title = '从左侧代码库点代码时，会加到这个段里（想换段就先点目标卡片）';
      head.insertBefore(tag, head.querySelector('.sec-tools'));
    } else if (!on && tag) {
      tag.remove();
    }
  });
  const sj = $('#secJump');
  if (sj) {
    const has = S.doc.sections.some(x => x.id === S.ui.activeSection);
    sj.value = has ? S.ui.activeSection : '';
  }
}

function suggestValue(fm) {
  if (!fm) return '';
  const k = fm.kind || 'string';
  if (k === 'bool') return 'false';
  if (k === 'time') return '1s';
  if (k === 'color') return '#ffffffff';
  if (k === 'enum:movementType') return 'LAND';
  if (k === 'integer' || k === 'float' || k === 'logic-number') return '0';
  if (k === 'price') return '100';
  if (k === 'special') return '';
  if (k === 'list' || k === 'tags') return '';
  return '';
}

function syncMobSave() {
  const b = $('#mobSave');
  if (b) b.classList.toggle('hidden', !(S.doc.dirty && isMobile()));
}

function markDirty(v = true) {
  S.doc.dirty = v;
  S.doc.rev = (S.doc.rev || 0) + 1;
  $('#dirtyDot').classList.toggle('on', v);
  syncMobSave();
}

function focusField(secId, key) {
  const row = document.querySelector('.row[data-fid="' + secId + '|' + cssEsc(key) + '"]');
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1200);
  const inp = row.querySelector('input,select,textarea');
  if (inp) inp.focus();
}
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

/* ============================================================
   4. 快速骨架模板
   ============================================================ */
const TEMPLATES = [
  {
    name: '① 基础单位', desc: '最小可用骨架：核心属性 + 图像 + 移动 + AI 开关',
    keys: ['name', 'price', 'maxHp', 'radius', 'mass', 'buildSpeed', 'techLevel', 'isBio', 'image', 'movementType', 'moveSpeed', 'useAsBuilder', 'useAsAttacker'],
    build() {
      const s = [];
      const core = newSection('core');
      core.entries = [['name', '新单位'], ['class', 'CustomUnitMetadata'], ['price', '100'],
        ['maxHp', '200'], ['mass', '3000'], ['radius', '12'], ['buildSpeed', '5s'],
        ['techLevel', '1'], ['isBio', 'false'], ['isBuilder', 'false']].map(([k, v]) => newEntry(k, v));
      const g = newSection('graphics');
      g.entries = [['image', '我的单位.png'], ['total_frames', '1'], ['image_shadow', 'AUTO']].map(([k, v]) => newEntry(k, v));
      const mv = newSection('movement');
      mv.entries = [['movementType', 'LAND'], ['moveSpeed', '1.2'], ['moveAccelerationSpeed', '0.06'], ['moveDecelerationSpeed', '0.06']].map(([k, v]) => newEntry(k, v));
      const ai = newSection('ai');
      ai.entries = [['useAsBuilder', 'false'], ['useAsAttacker', 'false']].map(([k, v]) => newEntry(k, v));
      return [core, g, mv, ai];
    }
  },
  {
    name: '② 战斗单位', desc: '带攻击：[attack] + [turret_1] + [projectile_1] 一整套',
    keys: ['canAttack', 'maxAttackRange', 'turretSize', 'shootDelay', 'projectile', 'delay', 'directDamage', 'areaDamage', 'areaRadius', 'speed', 'life'],
    build() {
      const s = TEMPLATES[0].build();
      s[0].entries.push(newEntry('displayText', '新单位'));
      const at = newSection('attack');
      at.entries = [['canAttack', 'true'], ['canAttackFlyingUnits', 'false'], ['canAttackLandUnits', 'true'],
        ['canAttackUnderwaterUnits', 'false'], ['maxAttackRange', '15'], ['turretSize', '1'],
        ['turretTurnSpeed', '2.5'], ['shootDelay', '60']].map(([k, v]) => newEntry(k, v));
      const tu = newSection('turret_1');
      tu.entries = [['projectile', '1'], ['x', '0'], ['y', '0'], ['delay', '60'], ['size', '1']].map(([k, v]) => newEntry(k, v));
      const pr = newSection('projectile_1');
      pr.entries = [['directDamage', '25'], ['life', '60'], ['speed', '2'], ['explodeEffect', 'smallExplosion']].map(([k, v]) => newEntry(k, v));
      const ai = s.find(x => x.name === 'ai');
      ai.entries[1] = newEntry('useAsAttacker', 'true');
      return [s[0], s[1], at, tu, pr, s[2], ai];
    }
  },
  {
    name: '③ 建筑物', desc: '建筑/工厂用：isBuilding + 占地 + 建造/维修能力',
    keys: ['isBuilding', 'footprint', 'constructionFootprint', 'buildSpeed', 'nanoRange', 'canRepairBuildings', 'canReclaimUnitsOnlyWithTags', 'exit_x', 'exit_y'],
    build() {
      const s = TEMPLATES[0].build();
      s[0].entries.push(newEntry('isBuilding', 'true'));
      s[0].entries.push(newEntry('footprint', '-3,-3,3,3'));
      s[0].entries.push(newEntry('constructionFootprint', '-3,-3,3,3'));
      s[0].entries.push(newEntry('selfBuildRate', '1'));
      const mv = s.find(x => x.name === 'movement');
      mv.entries = [newEntry('movementType', 'BUILDING')];
      const ai = s.find(x => x.name === 'ai');
      ai.entries = [['useAsBuilder', 'true'], ['useAsAttacker', 'false'], ['buildPriority', '0.4']].map(([k, v]) => newEntry(k, v));
      return s;
    }
  },
  {
    name: '④ 建造者/工厂', desc: '能造别的东西：isBuilder + [canBuild_N] 分段',
    keys: ['isBuilder', 'nanoRange', 'nanoBuildSpeed', 'canBuild', 'name', 'pos', 'isLocked', 'addResources'],
    build() {
      const s = TEMPLATES[0].build();
      s[0].entries.push(newEntry('isBuilder', 'true'));
      const ai = s.find(x => x.name === 'ai');
      ai.entries[0] = newEntry('useAsBuilder', 'true');
      const cb = newSection('canBuild_1');
      cb.entries = [['name', '要建造的单位名'], ['pos', '0'], ['isVisible', 'true'], ['isLocked', 'false']].map(([k, v]) => newEntry(k, v));
      return [...s, cb];
    }
  },
  {
    name: '⑤ 运输载具', desc: '能装别的东西：运输相关核心代码 + 卸载设置',
    keys: ['maxTransportingUnits', 'transportSlotsNeeded', 'transportUnitsRequireTag', 'transportUnitsCanUnloadUnits', 'transportUnitsHealBy', 'transportUnitsKillOnDeath'],
    build() {
      const s = TEMPLATES[0].build();
      s[0].entries.push(newEntry('maxTransportingUnits', '3'));
      s[0].entries.push(newEntry('transportSlotsNeeded', '100'));
      s[0].entries.push(newEntry('transportUnitsCanUnloadUnits', 'true'));
      s[0].entries.push(newEntry('transportUnitsHealBy', '0'));
      const ai = s.find(x => x.name === 'ai');
      ai.entries.unshift(newEntry('useAsTransport', 'true'));
      return s;
    }
  },
  {
    name: '⑥ 资源采集器/资源点', desc: '采集与资源节点：reclaim 相关代码',
    keys: ['canReclaimResources', 'resourceReclaimMultiplier', 'resourceRate', 'resourceMaxConcurrentReclaimingThis', 'reclaimPrice'],
    build() {
      const s = TEMPLATES[0].build();
      s[0].entries.push(newEntry('canReclaimResources', 'true'));
      s[0].entries.push(newEntry('resourceReclaimMultiplier', '1'));
      s[0].entries.push(newEntry('resourceRate', '0'));
      const ai = s.find(x => x.name === 'ai');
      ai.entries.unshift(newEntry('useAsHarvester', 'true'));
      return s;
    }
  },
  {
    name: '⑦ 特效/动画/动作', desc: '[effect_1] + [animation_1] + [action_1] 空壳，方便照着代码表填',
    keys: ['effect', 'life', 'image', 'animation', 'start', 'action', 'text', 'displayType'],
    build() {
      const ef = newSection('effect_1');
      ef.entries = [['life', '60'], ['image', '爆炸.png'], ['total_frames', '8'], ['scaleFrom', '0.5'], ['scaleTo', '1.4']].map(([k, v]) => newEntry(k, v));
      const an = newSection('animation_1');
      an.entries = [['onActions', 'true'], ['playbackRate', '1'], ['body_0', '0']].map(([k, v]) => newEntry(k, v));
      const ac = newSection('action_技能1');
      ac.entries = [['text', '按钮文字'], ['description', '说明文字'], ['displayType', 'action'],
        ['isVisible', 'true'], ['buildSpeed', '0s'], ['pos', '0']].map(([k, v]) => newEntry(k, v));
      return [ef, an, ac];
    }
  }
];

/* ============================================================
   5. 左栏：代码库
   ============================================================ */
function usedKeys() {
  const m = {};
  for (const s of S.doc.sections) for (const e of s.entries) if (e.key) m[e.key] = true;
  return m;
}

function renderLib() {
  const box = $('#libList');
  const used = usedKeys();
  const q = S.ui.search.trim().toLowerCase();
  const scope = S.ui.scope;
  let html = '';
  let total = 0;

  for (const sec of S.meta.sections) {
    let groupsHtml = '';
    let secCount = 0;
    for (const g of sec.groups) {
      const list = g.entries.filter(e => {
        if (scope === 'used' && !used[e.code]) return false;
        if (scope === 'unused' && used[e.code]) return false;
        if (q) {
          const hay = (e.code + ' ' + e.trans + ' ' + e.desc).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      if (!list.length) continue;
      secCount += list.length;
      groupsHtml += (g.name ? '<div class="grp-label">' + esc(g.name) + '</div>' : '') +
        list.map(e => entryHtml(e, used[e.code])).join('');
    }
    if (!secCount) continue;
    total += secCount;
    const closed = !!S.ui.closedLib[sec.id];
    html += '<div class="sec-group' + (closed ? ' closed' : '') + '" data-sec="' + esc(sec.id) + '">' +
      '<div class="sg-head"><span class="sg-caret">▼</span>' +
      '<span class="sg-title">' + esc(sec.title || sec.id) + '</span>' +
      '<span class="sg-raw">' + esc(sec.raw) + '</span>' +
      '<span class="sg-count">' + secCount + '</span></div>' +
      '<div class="sg-body">' + groupsHtml + '</div></div>';
  }
  if (!total) html = '<div class="no-result">没有找到匹配的代码<br>试试更短的关键词，比如「血」「攻击」「price」</div>';
  box.innerHTML = html;
  $('#libHint').textContent = q ? '匹配 ' + total + ' 条代码' : '点击条目把代码加入中间编辑区';
}

const KIND_BADGE = { bool: ['t-bool', 'bool'], integer: ['t-num', 'int'], float: ['t-num', 'float'],
  'logic-number': ['t-num', 'num'], price: ['t-num', 'price'], time: ['t-time', 'time'],
  color: ['t-color', 'color'], asset: ['t-str', 'image'], ref: ['t-ref', 'ref'],
  resources: ['t-ref', 'res'], list: ['t-list', 'list'], tags: ['t-list', 'tags'],
  numlist: ['t-list', '数字表'], string: ['t-str', 'str'], logic: ['t-str', 'logic'],
  special: ['t-str', '特殊写法'], enum: ['t-ref', 'enum'] };

function entryHtml(e, isUsed) {
  let cls = 't-str', label = e.vtype || 'string';
  if (e.kind && e.kind.startsWith('enum:')) { cls = 't-ref'; label = 'enum'; }
  else if (KIND_BADGE[e.kind]) { cls = KIND_BADGE[e.kind][0]; label = KIND_BADGE[e.kind][1]; }
  return '<div class="entry' + (isUsed ? ' used' : '') + '" data-code="' + esc(e.code) + '" data-sec="' + esc(e._secId) + '">' +
    '<span class="e-code">' + esc(e.code) + '</span>' +
    '<span class="e-trans">' + esc(e.trans || '') + '</span>' +
    '<span class="badge-t ' + cls + '">' + esc(label) + '</span></div>';
}

/* ============================================================
   6. 中栏：编辑器
   ============================================================ */
/* ---------- 中间：段跳转 / 字段筛选 ---------- */
function renderSecJump() {
  const sel = $('#secJump');
  if (!sel) return;
  const keep = S.ui.activeSection || sel.value || '';
  if (!S.doc.sections.length) {
    sel.innerHTML = '<option value="">（还没有段）</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = '<option value="">跳到段…</option>' + S.doc.sections.map(sec => {
    const sid = deriveSecId(sec.name);
    const meta = S.byId[sid];
    const n = sec.entries.filter(e => e.kind === 'field').length;
    const label = '[' + sec.name + ']' + (meta && meta.title ? ' ' + meta.title : '') + ' · ' + n + ' 字段';
    return '<option value="' + esc(sec.id) + '">' + esc(label) + '</option>';
  }).join('');
  sel.value = S.doc.sections.some(x => x.id === keep) ? keep : '';
}

function applyFieldFilter() {
  const q = String(S.ui.fieldFilter || '').trim().toLowerCase();
  const wrap = $('#midFilterWrap');
  const count = $('#fieldFilterCount');
  const inp = $('#fieldFilter');
  if (wrap) wrap.classList.toggle('has-text', !!q);
  if (inp && inp.value !== (S.ui.fieldFilter || '')) inp.value = S.ui.fieldFilter || '';
  const cards = $$('#editor .sec-card');
  const box = $('#editor');
  const oldHint = $('#filterEmpty');
  if (!q) {
    $$('#editor .row').forEach(r => r.classList.remove('filtered-out'));
    cards.forEach(c => c.classList.remove('filtered-out'));
    if (oldHint) oldHint.remove();
    if (count) count.textContent = '';
    return;
  }
  let total = 0;
  for (const card of cards) {
    let shown = 0;
    for (const row of card.querySelectorAll('.row')) {
      const code = row.querySelector('.r-code') ? row.querySelector('.r-code').textContent : '';
      const trans = row.querySelector('.r-trans') ? row.querySelector('.r-trans').textContent : '';
      const vals = Array.from(row.querySelectorAll('input,select,textarea'))
        .map(x => x.value).join(' ');
      const hit = (code + ' ' + trans + ' ' + vals).toLowerCase().includes(q);
      row.classList.toggle('filtered-out', !hit);
      if (hit) shown++;
    }
    card.classList.toggle('filtered-out', shown === 0);
    total += shown;
  }
  if (count) count.textContent = total ? total + ' 个字段' : '没有匹配';
  if (box) {
    let hint = oldHint;
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'filterEmpty';
      hint.className = 'filter-empty';
      box.prepend(hint);
    }
    hint.innerHTML = '没有匹配「<b>' + esc(q) + '</b>」的字段<br>换个关键词，或按 Esc 清空筛选';
    hint.style.display = total ? 'none' : 'block';
  }
}

function bindMidTools() {
  const inp = $('#fieldFilter');
  if (inp) {
    inp.value = S.ui.fieldFilter || '';
    inp.oninput = debounce(() => {
      S.ui.fieldFilter = inp.value;
      applyFieldFilter();
    }, 100);
    inp.onkeydown = ev => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        S.ui.fieldFilter = '';
        inp.value = '';
        applyFieldFilter();
        inp.blur();
      }
    };
  }
  const clear = $('#fieldFilterClear');
  if (clear) clear.onclick = () => {
    S.ui.fieldFilter = '';
    if (inp) { inp.value = ''; inp.focus(); }
    applyFieldFilter();
  };
  const sel = $('#secJump');
  if (sel) sel.onchange = () => {
    const sec = S.doc.sections.find(x => x.id === sel.value);
    if (!sec) return;
    if (S.ui.fieldFilter) {
      S.ui.fieldFilter = '';
      if (inp) inp.value = '';
      applyFieldFilter();
    }
    if (sec.collapsed) { sec.collapsed = false; renderEditor(); }
    S.ui.activeSection = sec.id;
    highlightActiveSection();
    setTimeout(() => {
      const card = document.querySelector('.sec-card[data-sid="' + sec.id + '"]');
      if (card) {
        card.scrollIntoView({ block: 'start', behavior: 'smooth' });
        card.classList.add('sec-flash');
        setTimeout(() => card.classList.remove('sec-flash'), 1200);
      }
    }, 30);
  };
}

function renderEditor() {
  const box = $('#editor');
  const secs = S.doc.sections;
  const fp = S.doc.path || '';
  if (S.ui._filterDocPath !== fp) {
    S.ui._filterDocPath = fp;
    S.ui.fieldFilter = '';
  }
  if (!secs.length) {
    box.innerHTML = '<div class="empty-tip">还没有任何代码<br>从左边点一条代码，或点顶部 <b>模板</b> 选一个骨架开始<br>也可以用 <b>打开</b> 载入已有单位 ini</div>';
    renderSecJump(); applyFieldFilter(); updateCounts(); return;
  }
  const issueMap = {};
  for (const it of S.ui.issues) if (it.section && it.key) issueMap[it.section + '|' + it.key] = it.level;

  box.innerHTML = secs.map((sec, si) => {
    const secId = deriveSecId(sec.name);
    const meta = S.byId[secId];
    return '<div class="sec-card k-' + esc(secId) + (sec.collapsed ? ' closed' : '') + '" data-sid="' + sec.id + '" data-secid="' + esc(secId) + '">' +
      '<div class="sec-head">' +
      '<span class="sec-caret" data-act="collapse">▼</span>' +
      '<input class="sec-name" value="' + esc(sec.name) + '" data-act="rename" data-sid="' + sec.id +
      '" spellcheck="false" size="' + Math.max(10, sec.name.length + 2) + '">' +
      '<span class="sec-title">' + esc(meta ? meta.title : '未在代码表中登记的自定义段') + '</span>' +
      '<span class="sec-count">' + sec.entries.filter(e => e.kind === 'field').length + ' 字段</span>' +
      '<span class="sec-tools">' +
      '<button class="icon-btn" data-act="packsec" title="整段存入背包（可在别的单位里一键复用）">❐</button>' +
      '<button class="icon-btn" data-act="up" title="上移">↑</button>' +
      '<button class="icon-btn" data-act="down" title="下移">↓</button>' +
      '<button class="icon-btn danger" data-act="delsec" title="删除整段">🗑</button>' +
      '</span></div>' +
      '<div class="sec-body">' +
      (sec.entries.length ? sec.entries.map((e, ei) => rowHtml(sec, secId, e, ei, issueMap)).join('')
        : '<div class="hint" style="padding:10px;text-align:left;color:var(--txt3)">这一段还是空的 —— 在左侧搜索并点击字段加入；或点下面的「＋ 添加字段」</div>') +
      '<div style="padding:6px 7px"><button class="btn small ghost" data-act="addfield">＋ 添加字段</button></div>' +
      '</div></div>';
  }).join('');
  bindEditorEvents();
  highlightActiveSection();
  renderSecJump();
  applyFieldFilter();
  updateCounts();
}

function rowHtml(sec, secId, e, ei, issueMap) {
  if (e.kind === 'raw') {
    return '<div class="row" data-eid="' + e.id + '"><div class="r-label"><span class="r-trans">原始行</span></div>' +
      '<div class="r-ctl"><input class="field-w mono" type="text" value="' + esc(e.value) + '" data-act="raw" data-eid="' + e.id + '"></div>' +
      '<div class="r-right"><button class="icon-btn danger" data-act="delfield" data-eid="' + e.id + '">×</button></div></div>';
  }
  const fm = fieldMeta(secId, e.key) || (findKeyMeta(e.key) || [])[0]?.entry || null;
  const lvl = e.cnColon ? 'error' : (issueMap[sec.name + '|' + e.key] || issueMap[secId + '|' + e.key]);
  const msg = e.cnColon
    ? { level: 'error', short: '这一行用了中文冒号「：」，游戏读不到，导出时会自动修正' }
    : S.ui.issues.find(i => i.key === e.key && (i.section === sec.name || i.section === secId));
  const kind = fm ? (fm.kind || 'string') : e.forcedKind || 'string';
  return '<div class="row' + (lvl === 'error' ? ' has-err' : lvl === 'warn' ? ' has-warn' : '') +
    (isPicked(sec.name, e.key) ? ' picked' : '') +
    '" data-eid="' + e.id + '" data-fid="' + esc(secId) + '|' + esc(e.key) + '">' +
    '<div class="r-label"><div class="r-top">' +
    '<span class="r-code">' + esc(e.key) + '</span>' +
    (fm ? '<span class="badge-t ' + badgeCls(kind) + '">' + esc(shortType(fm)) + '</span>'
        : '<span class="badge-t t-ref" title="代码表里没有登记这个键">未知</span>') +
    '</div>' +
    '<span class="r-trans">' + esc(fm ? fm.trans : '（不在代码表中）') + '</span></div>' +
    '<div class="r-ctl">' + controlHtml(sec, e, fm, kind) +
    (msg && msg.level !== 'info' ? '<div class="r-msg ' + (msg.level === 'error' ? 'err' : 'warn') + '">⚠ ' + esc(msg.short || msg.title) + '</div>' : '') +
    '</div>' +
    '<div class="r-right">' +
    '<button class="icon-btn star-btn' + (isPicked(sec.name, e.key) ? ' on' : '') +
    '" data-act="star" data-eid="' + e.id + '" title="勾选这个键，存进背包当模块复用">' +
    (isPicked(sec.name, e.key) ? '★' : '☆') + '</button>' +
    (fm ? '<button class="icon-btn" data-act="help" data-eid="' + e.id + '" title="查看说明">?</button>' : '') +
    '<button class="icon-btn danger" data-act="delfield" data-eid="' + e.id + '" title="删除">×</button>' +
    '</div></div>';
}

function badgeCls(kind) {
  if (kind.startsWith('enum:')) return 't-ref';
  return (KIND_BADGE[kind] || ['t-str'])[0];
}
function shortType(fm) {
  if (fm.kind && fm.kind.startsWith('enum:')) return 'enum';
  return fm.vtype || fm.kind || 'string';
}

/* -------- 各类输入控件 -------- */
function controlHtml(sec, e, fm, kind) {
  const v = e.value;
  const bind = 'data-act="val" data-eid="' + e.id + '"';
  const mn = fm ? guessRange(fm) : null;

  if (kind === 'bool') {
    const raw = String(v).trim();
    const on = /^(true|on|yes)$/i.test(raw);
    const isBoolish = on || /^(false|off|no)$/i.test(raw);
    const isLogic = (fm && /LogicBoolean/i.test(fm.vtype)) || !isBoolish;
    if (isLogic) {
      return '<div class="two"><select ' + bind + ' class="w110"><option value="true"' + (on ? ' selected' : '') + '>true</option>' +
        '<option value="false"' + (!on && /^(false|off|no)$/i.test(raw) ? ' selected' : '') + '>false</option>' +
        '<option value="__expr"' + (!isBoolish ? ' selected' : '') + '>自定义表达式</option></select>' +
        (!isBoolish ? '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind + ' placeholder="if self.tags(...)">' : '') +
        '</div>';
    }
    return '<label class="switch"><input type="checkbox" value="true" ' + bind + (on ? ' checked' : '') + '>' +
      '<span class="sw-track"></span></label><span class="sw-label">' + (on ? 'true 开启' : 'false 关闭') + '</span>';
  }
  if (kind === 'enum:movementType') {
    return enumSelect('movementType', v, bind);
  }
  if (kind.startsWith('enum:')) return enumSelect(kind.slice(5), v, bind);

  if (fm && RES_KEYS.indexOf(fm.code) >= 0) {
    return '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind +
      ' list="dl-globals" placeholder="资源名=数量，多个用逗号分隔">' + globalsHint();
  }
  if (kind === 'integer' || kind === 'float' || kind === 'logic-number' || kind === 'price') {
    const step = kind === 'integer' ? '1' : '0.01';
    // 值不是纯数字时改用文本框：浏览器会把非法数字显示成空白，看不到自己写错的内容
    if (!/^-?[\d.]*$/.test(String(v).trim()) && !looksLikeExpr(v)) {
      return '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind + '>' +
        '<span class="sw-label" style="color:var(--red)">这里应该是数字</span>';
    }
    let html = '<input class="num mono" type="number" step="' + step + '" value="' + esc(v) + '" ' + bind + '>';
    if (mn && mn.max != null && mn.max - mn.min <= 100) {
      const cur = parseFloat(v) || 0;
      html += '<input class="slider" type="range" min="' + mn.min + '" max="' + mn.max + '" step="' + step + '" value="' + cur + '" ' + bind + '>';
      html += '<span class="numval">' + esc(v) + '</span>';
    }
    if (mn) html += '<span class="sw-label" title="说明里建议的范围">' + (mn.min) + '~' + (mn.max == null ? '?' : mn.max) + '</span>';
    return html;
  }
  if (kind === 'time') {
    const m = String(v).match(/^(-?[\d.]+)\s*(s|ms|帧)?\s*$/);
    const num = m ? m[1] : v, unit = m && m[2] ? m[2] : 's';
    return '<input class="num mono" type="text" value="' + esc(num) + '" data-act="time" data-eid="' + e.id + '">' +
      '<select class="w60" data-act="timeunit" data-eid="' + e.id + '">' +
      ['s', 'ms', '帧'].map(u => '<option' + (u === unit ? ' selected' : '') + '>' + u + '</option>').join('') + '</select>' +
      '<span class="sw-label">例：3s / 500ms / 60帧</span>';
  }
  if (kind === 'color') {
    const hex = /^#[0-9a-f]{6,8}$/i.test(v.trim()) ? v.trim() : '#ffffffff';
    return '<input type="color" value="' + esc(hex.slice(0, 7)) + '" data-act="color" data-eid="' + e.id + '">' +
      '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind + ' placeholder="#RRGGBB 或 #AARRGGBB">';
  }
  if (kind === 'tags') {
    const tags = v.split(/[,，]/).map(x => x.trim()).filter(Boolean);
    return '<div class="chips" data-act="chips" data-eid="' + e.id + '">' +
      tags.map((t, i) => '<span class="chip-tag">' + esc(t) + '<button data-act="chiptag-del" data-i="' + i + '">×</button></span>').join('') +
      '<input type="text" placeholder="输入后回车添加…" data-act="chipinput" data-eid="' + e.id + '"></div>';
  }
  if (kind === 'asset') {
    const list = (S.meta.enums['builtinImage'] || { items: [] }).items.concat(
      (S.meta.enums['builtinSound'] || { items: [] }).items);
    return '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind + ' list="dl-asset" placeholder="图片名.png / 音效名 / ROOT:/路径">' + assetDatalist(list);
  }
  if (kind === 'ref') {
    return '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind + ' list="dl-units" placeholder="引用名称 / 数字索引">' + refDatalist();
  }
  if (kind === 'special') {
    return '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind +
      ' placeholder="按代码表的特殊写法填，例如 canBuild_1_name: tank">' +
      '<span class="sw-label">特殊写法·填字符串</span>';
  }
  if (kind === 'resources') {
    return '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind +
      ' list="dl-globals" placeholder="credits=100, 资源名=数量">' + globalsHint();
  }
  if (kind === 'list' || kind === 'numlist') {
    return '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind +
      (kind === 'numlist' ? ' placeholder="数字之间用英文逗号，如 -3,-3,3,3"' : ' placeholder="多个值用英文逗号分隔"') + '>';
  }
  if (kind === 'logic') {
    return '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind + ' placeholder="if self.hp &gt; 50">';
  }
  // string
  if ((fm && fm.desc && fm.desc.length > 120) || String(v).length > 46 || /\n/.test(v)) {
    return '<textarea class="field-w mono" ' + bind + ' rows="2">' + esc(v) + '</textarea>';
  }
  return '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind + '>';
}

let _dlSeed = 0;
function assetDatalist(list) {
  const id = 'dl-asset';
  if (!document.getElementById(id)) {
    const dl = document.createElement('datalist'); dl.id = id;
    dl.innerHTML = (list || []).map(x => '<option value="' + esc(x.v) + '">' + esc(x.t || '') + '</option>').join('');
    document.body.appendChild(dl);
  }
  return '';
}
/* 值里会出现全局变量名的键 */
const RES_KEYS = ['addResources', 'price', 'resourceUsage', 'generation_resources',
  'setResourcesWithLogic', 'borrowResourcesWhileAlive', 'borrowResourcesWhileBuilt',
  'resourcesNeededToStart', 'customResource', 'equivalentGlobalResourceForAI',
  'appendResourceInHUD', 'displayTextAppendResource'];

/** 全局变量清单：本文件定义的 + 模组扫描到的 + 游戏内置的 */
function globalVarList() {
  const out = new Map();
  for (const s of S.doc.sections) {
    const id = deriveSecId(s.name);
    if (id !== 'global_resource' && id !== 'resource') continue;
    const nm = String(s.name).replace(/^\[|\]$/g, '')
      .replace(/^global_resource_/i, '').replace(/^resource_/i, '');
    const kv = {};
    for (const e of s.entries) if (e.key) kv[e.key] = e.value;
    out.set(nm, { name: nm, display: kv.displayName || kv.displayNameShort || '', local: true });
  }
  if (S.scan && S.scan.ok) {
    for (const g of S.scan.globals || []) {
      if (!out.has(g.name)) out.set(g.name, { name: g.name, display: g.displayName || '', local: false, rel: g.rel });
    }
  }
  for (const b of BUILTIN_RES) if (!out.has(b)) out.set(b, { name: b, display: '游戏内置', builtin: true });
  return Array.from(out.values());
}

/** 资源输入框下方的可用全局变量提示 + datalist */
function globalsHint() {
  ensureGlobalsDatalist();
  const list = globalVarList().filter(x => !x.builtin);
  if (!list.length) return '<span class="sw-label">还没读到全局变量（正在后台扫描模组）</span>';
  const mine = list.filter(x => x.local);
  const shown = (mine.length ? mine : list).slice(0, 6)
    .map(x => x.name + (x.display && x.display !== x.name ? '（' + x.display + '）' : ''));
  return '<span class="sw-label" title="当前文件/模组里已定义的全局变量，可以直接填">' +
    (mine.length ? '本文件已定义：' : '模组里已定义：') + esc(shown.join('、')) +
    (list.length > shown.length ? ' 等 ' + list.length + ' 个' : '') + '</span>';
}

function ensureGlobalsDatalist() {
  let dl = document.getElementById('dl-globals');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'dl-globals';
    document.body.appendChild(dl);
  }
  const list = globalVarList();
  const sig = list.map(x => x.name).join(',');
  if (dl.dataset.sig !== sig) {
    dl.innerHTML = list.map(x => '<option value="' + esc(x.name) + '">' +
      esc(x.display || (x.builtin ? '游戏内置资源' : (x.local ? '本文件定义' : '模组里定义'))) + '</option>').join('');
    dl.dataset.sig = sig;
  }
}

function refDatalist() {
  const id = 'dl-units';
  if (!document.getElementById(id)) {
    const dl = document.createElement('datalist'); dl.id = id;
    const units = (S.meta.enums['unitListDex'] || { items: [] }).items;
    const mine = S.doc.sections.flatMap(s => s.entries.filter(e => e.key === 'name').map(e => e.value));
    const all = Array.from(new Set(mine.concat(units.map(u => u.v)))).filter(Boolean);
    dl.innerHTML = all.map(x => '<option value="' + esc(x) + '">').join('');
    document.body.appendChild(dl);
  } else {
    const dl = document.getElementById(id);
    const mine = S.doc.sections.flatMap(s => s.entries.filter(e => e.key === 'name').map(e => e.value));
    const units = (S.meta.enums['unitListDex'] || { items: [] }).items.map(u => u.v);
    const all = Array.from(new Set(mine.concat(units))).filter(Boolean);
    if (dl.dataset.n !== String(all.length)) {
      dl.innerHTML = all.map(x => '<option value="' + esc(x) + '">').join('');
      dl.dataset.n = String(all.length);
    }
  }
  return '';
}
function enumSelect(enumId, v, bind) {
  const en = S.meta.enums[enumId];
  if (!en) return '<input class="field-w mono" type="text" value="' + esc(v) + '" ' + bind + '>';
  const has = en.items.some(it => it.v === v.trim());
  let html = '<select class="field-w" ' + bind + '>';
  if (!has) html += '<option value="' + esc(v) + '" selected>' + esc(v || '（空）') + ' ← 自定义</option>';
  html += en.items.map(it => '<option value="' + esc(it.v) + '"' + (it.v === v.trim() ? ' selected' : '') + '>' +
    esc(it.v) + (it.t ? '　—　' + esc(it.t) : '') + '</option>').join('');
  html += '</select>';
  return html;
}

function guessRange(fm) {
  if (!fm) return null;
  const d = (fm.desc || '') + ' ' + (fm.trans || '');
  let m = d.match(/(?:填|设置|建议|默认)?\s*([\d.]+)\s*[-~到]\s*([\d.]+)/);
  if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  m = d.match(/(?:填|设置|建议)?\s*(0)\s*[-~到]\s*(1)/);
  if (m) return { min: 0, max: 1 };
  if (fm.vtype === 'bool') return null;
  return null;
}

/* -------- 编辑器事件 -------- */
function bindEditorEvents() {
  const box = $('#editor');
  box.oninput = ev => {
    const t = ev.target, eid = t.dataset.eid, act = t.dataset.act;
    if (act === 'rename') {
      const sec = S.doc.sections.find(s => s.id === t.dataset.sid);
      if (!sec) return;
      sec.name = t.value;
      markDirty();
      onSectionRenamed();
      return;
    }
    if (!eid) return;
    const found = findEntry(eid); if (!found) return;
    if (act === 'val') {
      // 复选框不能读 .value（默认永远是 "on"），必须按 checked 写 true/false
      found.entry.value = t.type === 'checkbox' ? (t.checked ? 'true' : 'false') : t.value;
      if (t.type === 'checkbox') {
        const sw = t.closest('.switch');
        const lab = sw && sw.nextElementSibling;
        if (lab) lab.textContent = t.checked ? 'true 开启' : 'false 关闭';
      }
      markDirty();
      softUpdate(found.sec, found.entry, t);
    }
    else if (act === 'raw') { found.entry.value = t.value; markDirty(); softUpdate(found.sec, found.entry, t); }
    else if (act === 'time') {
      const unit = (box.querySelector('select[data-act="timeunit"][data-eid="' + eid + '"]') || {}).value || 's';
      found.entry.value = t.value + unit; markDirty(); softUpdate(found.sec, found.entry, t);
    }
  };
  box.onchange = ev => {
    const t = ev.target, eid = t.dataset.eid, act = t.dataset.act;
    const cardEl2 = ev.target.closest('.sec-card');
    if (cardEl2 && cardEl2.dataset.sid) { S.ui.activeSection = cardEl2.dataset.sid; highlightActiveSection(); }
    if (act === 'timeunit' && eid) {
      const found = findEntry(eid); if (!found) return;
      const num = (box.querySelector('input[data-act="time"][data-eid="' + eid + '"]') || {}).value || '0';
      found.entry.value = num + t.value; markDirty(); softUpdate();
    }
    if (act === 'color' && eid) {
      const found = findEntry(eid); if (!found) return;
      found.entry.value = t.value + 'ff'; markDirty(); renderAll();
    }
    if (act === 'val' && eid) {
      const found = findEntry(eid);
      if (found && t.type === 'checkbox') found.entry.value = t.checked ? 'true' : 'false';
      softUpdate();
    }
  };
  box.onkeydown = ev => {
    const t = ev.target;
    if (t.dataset.act === 'chipinput' && ev.key === 'Enter') {
      ev.preventDefault();
      const eid = t.dataset.eid, found = findEntry(eid); if (!found) return;
      const val = t.value.trim(); if (!val) return;
      const tags = found.entry.value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
      if (!tags.includes(val)) tags.push(val);
      found.entry.value = tags.join(','); markDirty(); renderAll();
      setTimeout(() => { const i2 = document.querySelector('.chips[data-eid="' + eid + '"] input'); if (i2) i2.focus(); }, 20);
    }
  };
  box.onclick = ev => {
    // 记住当前操作的段：点卡片、点字段、聚焦输入，都会把它设为“当前段”
    const cardEl = ev.target.closest('.sec-card');
    if (cardEl && cardEl.dataset.sid && S.ui.activeSection !== cardEl.dataset.sid) {
      S.ui.activeSection = cardEl.dataset.sid;
      highlightActiveSection();
    }
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const card = btn.closest('.sec-card');
    const secId = card ? card.dataset.sid : null;
    if (act === 'collapse') {
      const sec = S.doc.sections.find(s => s.id === secId); sec.collapsed = !sec.collapsed; renderEditor(); return;
    }
    if (act === 'up' || act === 'down' || act === 'delsec') {
      const i = S.doc.sections.findIndex(s => s.id === secId);
      if (act === 'delsec') {
        if (confirm('确定删除整段 [' + S.doc.sections[i].name + '] 吗？')) {
          S.doc.sections.splice(i, 1); markDirty(); renderAll();
        }
      } else {
        const j = act === 'up' ? i - 1 : i + 1;
        if (j >= 0 && j < S.doc.sections.length) {
          [S.doc.sections[i], S.doc.sections[j]] = [S.doc.sections[j], S.doc.sections[i]];
          markDirty(); renderAll();
        }
      }
      return;
    }
    if (act === 'star') {
      const f = findEntry(btn.dataset.eid);
      if (f) togglePick(f.sec, f.entry);
      return;
    }
    if (act === 'packsec') { packSection(secId); return; }
    if (act === 'addfield') { openAddFieldModal(secId); return; }
    if (act === 'delfield') { const f = findEntry(btn.dataset.eid); if (f) { f.sec.entries = f.sec.entries.filter(x => x.id !== btn.dataset.eid); markDirty(); renderAll(); } return; }
    if (act === 'help') { showHelp(btn.dataset.eid, btn); return; }
    if (act === 'chiptag-del') {
      const f = findEntry(btn.closest('[data-act="chips"]').dataset.eid);
      if (f) {
        const tags = f.entry.value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
        tags.splice(parseInt(btn.dataset.i, 10), 1);
        f.entry.value = tags.join(','); markDirty(); renderAll();
      }
      return;
    }
  };
}
function onSectionRenamed() {
  // 段名变化 → 更新计数与引用提示（不重建 DOM，避免输入丢失焦点）
  renderPreviewAll();
  updateCounts();
}
function findEntry(eid) {
  for (const sec of S.doc.sections) {
    const entry = sec.entries.find(e => e.id === eid);
    if (entry) return { sec, entry };
  }
  return null;
}
function softUpdate() { renderPreviewAll(); }

/* --------- 帮助气泡 --------- */
function showHelp(eid, anchor) {
  const f = findEntry(eid); if (!f) return;
  const secId = deriveSecId(f.sec.name);
  const fm = fieldMeta(secId, f.entry.key) || (findKeyMeta(f.entry.key) || [])[0]?.entry || null;
  if (!fm) return;
  const tip = $('#tipBox');
  tip.innerHTML = '<span class="tt">' + esc(fm.trans || fm.code) + ' <span class="tc">' + esc(fm.code) + '</span></span>' +
    (fm.vtype ? '<div class="tv">值类型：' + esc(fm.vtype) + '</div>' : '') +
    '<div class="td">' + esc(fm.desc || '（代码表没有写说明）') + '</div>' +
    (fm.ex ? '<div class="te">' + esc(fm.ex) + '</div>' : '') +
    '<div class="tv" style="margin-top:5px">所属段：' + esc(secId) + '　序号 ' + ((fm._order || 0) + 1) + '</div>';
  tip.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = Math.min(400, tip.offsetWidth || 380);
  let left = Math.min(window.innerWidth - w - 12, r.right + 10);
  let top = Math.min(window.innerHeight - tip.offsetHeight - 12, r.top);
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = Math.max(8, top) + 'px';
}
document.addEventListener('click', e => {
  if (!e.target.closest('#tipBox') && !e.target.closest('[data-act="help"]')) $('#tipBox').classList.add('hidden');
});

/* ============================================================
   7. 预览：代码
   ============================================================ */
function renderCode() {
  const cv = $('#codeView');
  const keepTop = cv ? cv.scrollTop : 0;
  const text = serialize(S.doc, { blank: $('#optBlank').checked, comment: $('#optComment').checked });
  const lines = text.split('\n');
  const errLines = new Set();
  const warnLines = new Set();
  let curSec = '';
  lines.forEach((ln, i) => {
    const m = ln.match(/^\[(.+)\]$/);
    if (m) curSec = m[1];
    const f = ln.match(/^([A-Za-z0-9_.#\u4e00-\u9fff\-]+)\s*:/);
    if (f) {
      const iss = S.ui.issues.filter(x => x.key === f[1] && (x.section === curSec || x.section === deriveSecId(curSec)));
      if (iss.some(x => x.level === 'error')) errLines.add(i);
      else if (iss.some(x => x.level === 'warn')) warnLines.add(i);
    }
  });
  $('#codeView').innerHTML = lines.map((ln, i) => {
    const cls = errLines.has(i) ? ' h-err' : warnLines.has(i) ? ' h-warn' : '';
    return '<div class="cl"><span class="ln">' + (i + 1) + '</span><span class="ct' + cls + '">' + hl(ln) + '</span></div>';
  }).join('');
  if (cv) cv.scrollTop = keepTop;
}

function hl(line) {
  if (!line.trim()) return '';
  if (/^\s*[#;]/.test(line)) return '<span class="h-com">' + esc(line) + '</span>';
  const m = line.match(/^(\s*)(\[)(.+)(\])\s*$/);
  if (m) return esc(m[1]) + '<span class="h-sec">[' + esc(m[3]) + ']</span>';
  const kv = line.match(/^([A-Za-z0-9_.#\u4e00-\u9fff\-]+)(\s*[:=]\s*)([\s\S]*)$/);
  if (kv) {
    const v = kv[3];
    let vc = 'h-val';
    if (/^(true|false)$/i.test(v.trim())) vc = 'h-bool';
    else if (/^-?[\d.]+\s*(s|ms|帧)?$/.test(v.trim())) vc = 'h-num';
    else if (/^(ROOT:|CUSTOM:|shared|if\s|select\()/i.test(v.trim())) vc = 'h-ref';
    else if (/^\d+([,.]\d+)*$/.test(v.trim())) vc = 'h-ref';
    return '<span class="h-key">' + esc(kv[1]) + '</span>' + esc(kv[2]) + '<span class="' + vc + '">' + esc(v) + '</span>';
  }
  return esc(line);
}

/* ============================================================
   8. 预览：效果（可视化）
   ============================================================ */
function getCore() {
  const core = secOf('core')[0];
  const m = {};
  if (core) for (const e of core.entries) if (e.key) m[e.key] = e.value;
  return m;
}
function num(v, d) { const n = parseFloat(String(v).replace(/[^\d.\-]/g, '')); return isNaN(n) ? (d == null ? 0 : d) : n; }
function parseTimeS(v) {
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^([\d.]+)\s*ms$/i); if (m) return parseFloat(m[1]) / 1000;
  m = s.match(/^([\d.]+)\s*(?:s|秒)?$/i); if (m) return parseFloat(m[1]);
  m = s.match(/^([\d.]+)\s*帧$/); if (m) return parseFloat(m[1]) / 60;
  return NaN;
}
const TILE = 20;   // 铁锈 1 地块 = 20 像素

function collectUnits() {
  const core = getCore();
  const gfx = firstSecMap('graphics');
  const atk = firstSecMap('attack');
  const mv = firstSecMap('movement');
  const turrets = [], projectiles = [], attachments = [], effects = [], actions = [];
  for (const s of S.doc.sections) {
    const id = deriveSecId(s.name);
    const map = {};
    for (const e of s.entries) if (e.key) map[e.key] = e.value;
    if (id === 'turret') turrets.push({ name: s.name, map, idx: num(s.name.match(/(\d+)\s*$/)?.[1], 0) });
    if (id === 'projectile') projectiles.push({ name: s.name, map, idx: num(s.name.match(/(\d+)\s*$/)?.[1], 0) });
    if (id === 'attachment') attachments.push({ name: s.name, map });
    if (id === 'effect') effects.push({ name: s.name, map });
    if (id === 'action') actions.push({ name: s.name, map });
  }
  turrets.sort((a, b) => a.idx - b.idx);
  projectiles.sort((a, b) => a.idx - b.idx);
  return { core, gfx, atk, mv, turrets, projectiles, attachments, effects, actions };
}
function firstSecMap(id) {
  const s = secOf(id)[0];
  if (!s) return {};
  const m = {};
  for (const e of s.entries) if (e.key) m[e.key] = e.value;
  return m;
}
/** 大小写不敏感地取一个字段；RW 官方死亡贴图键名是 image_wreak（拼写如此） */
function gfxVal(m, key) {
  if (!m) return '';
  if (m[key] != null) return m[key];
  const lk = String(key).toLowerCase();
  for (const k of Object.keys(m)) if (String(k).toLowerCase() === lk) return m[k];
  return '';
}
function deathImageOf(g) {
  return String(gfxVal(g, 'image_wreak') || gfxVal(g, 'image_wreck') || gfxVal(g, 'image_dead') || '').trim();
}
function hasDeathImage(g) {
  const v = deathImageOf(g);
  return !!v && !/^(NONE|AUTO)$/i.test(v);
}

function renderEffect() {
  if (S.ui.canvasPath !== (S.doc.path || '')) {
    S.ui.canvasPath = S.doc.path || '';
    S.ui.canvasZoom = 1;
    S.ui.canvasPan = { x: 0, y: 0 };
  }
  syncFxStateButtons();
  const U = collectUnits();
  const c = U.core;
  const deadRef = deathImageOf(U.gfx);
  const deadSet = hasDeathImage(U.gfx);
  const name = c.name || '(未命名)';
  const disp = c.displayText || name;
  const hp = num(c.maxHp), sh = num(c.maxShield);
  const tech = num(c.techLevel, 1);
  const price = num(c.price);
  const buildS = parseTimeS(c.buildSpeed);
  const radius = num(c.radius, 12);
  const move = (U.mv.movementType || '').toUpperCase();
  const MOVE_TXT = { NONE: '无（固定）', LAND: '陆地', BUILDING: '建筑', AIR: '空中', WATER: '水面', HOVER: '两栖 / 悬浮', OVER_CLIFF: '跨悬崖', OVER_CLIFF_WATER: '跨水与悬崖' };

  // ---- 头部卡片
  const tags = String(c.tags || '').split(/[,，]/).map(x => x.trim()).filter(Boolean).slice(0, 14);
  $('#fxHero').innerHTML =
    '<div class="fx-name">' + esc(disp) + '</div>' +
    '<div class="fx-sub">' + esc(name) + (c.altNames ? '　别名: ' + esc(c.altNames) : '') + '</div>' +
    '<div class="fx-tags">' +
    '<span class="fx-tag b-move">' + (move ? esc(MOVE_TXT[move] || move) : '未设置移动类型') + '</span>' +
    '<span class="fx-tag b-tech">科技 ' + esc(tech) + ' 级</span>' +
    (/(true)/i.test(c.isBuilding || '') ? '<span class="fx-tag b-attr">建筑</span>' : '') +
    (/(true)/i.test(c.isBuilder || '') ? '<span class="fx-tag b-attr">建造者</span>' : '') +
    (/(true)/i.test(c.isBio || '') ? '<span class="fx-tag b-attr">生物</span>' : '') +
    (/(true)/i.test(c.isBug || '') ? '<span class="fx-tag b-attr">虫子</span>' : '') +
    (U.core.experimental === 'true' ? '<span class="fx-tag b-attr">实验级</span>' : '') +
    (num(c.maxTransportingUnits) > 0 ? '<span class="fx-tag b-attr">运输 ' + num(c.maxTransportingUnits) + ' 格</span>' : '') +
    (/(true)/i.test(c.canReclaimResources || '') ? '<span class="fx-tag b-attr">采集者</span>' : '') +
    (secOf('canBuild').length ? '<span class="fx-tag b-attr">可建造 ' + secOf('canBuild').length + ' 项</span>' : '') +
    tags.map(t => '<span class="fx-tag">' + esc(t) + '</span>').join('') +
    '</div>' +
    barsHtml(c, hp, sh, buildS, price);

  // ---- 武器卡
  const wlist = [];
  for (const t of U.turrets) {
    const pIdx = String(t.map.projectile || '').trim();
    const pr = U.projectiles.find(p => String(p.idx) === pIdx) ||
               U.projectiles.find(p => p.name.replace(/^projectile_?/i, '') === pIdx);
    const delayRaw = t.map.delay != null ? t.map.delay : U.atk.shootDelay;
    // 开火间隔：纯数字=帧(60帧/秒)，也可以写 2.2s / 500ms
    let shotsPerSec = NaN, delayTxt = '—';
    if (delayRaw != null && String(delayRaw).trim()) {
      const raw = String(delayRaw).trim();
      if (isNumber(raw)) {
        const f = parseFloat(raw);
        if (f > 0) { shotsPerSec = 60 / f; delayTxt = f + ' 帧（' + round1(f / 60) + ' 秒）'; }
      } else {
        const m = raw.match(/^([\d.]+)\s*(s|ms|帧)$/);
        if (m) {
          const secs = m[2] === 'ms' ? parseFloat(m[1]) / 1000 : m[2] === '帧' ? parseFloat(m[1]) / 60 : parseFloat(m[1]);
          if (secs > 0) { shotsPerSec = 1 / secs; delayTxt = raw + '（' + round1(secs) + ' 秒）'; }
        }
      }
    }
    const dd = pr ? num(pr.map.directDamage) : NaN;
    const ad = pr ? num(pr.map.areaDamage) : NaN;
    const dps = isFinite(shotsPerSec) && isFinite(dd) ? dd * shotsPerSec : NaN;
    wlist.push({ t, pr, pIdx, delayTxt, dd, ad, dps, shotsPerSec });
  }
  $('#fxWeapons').innerHTML = wlist.length ? wlist.map((w, i) => {
    const p = w.pr ? w.pr.map : null;
    return '<div class="wcard"><h4>炮塔 ' + esc(w.t.name) +
      '<span class="wp">projectile: ' + esc(w.pIdx || '未填') + '</span>' +
      (w.pr ? '' : '<span class="wp" style="color:var(--red);border-color:#ff5f6d55">未找到抛射体段</span>') + '</h4>' +
      '<div class="wgrid">' +
      cell('直接伤害', p ? (p.directDamage || '0') : '—') +
      cell('范围伤害', p && p.areaDamage ? p.areaDamage + (p.areaRadius ? ' / R' + p.areaRadius : '') : '—') +
      cell('开火间隔', w.delayTxt) +
      cell('每秒伤害(估)', isFinite(w.dps) ? round1(w.dps) : '—') +
      cell('弹速', p ? (p.speed || (p.instant === 'true' ? '瞬发' : '—')) : '—') +
      cell('存活', p ? (p.life ? p.life + ' 帧' : '—') : '—') +
      cell('炮塔位置', (w.t.map.x || 0) + ', ' + (w.t.map.y || 0)) +
      cell('可攻击', attackTargets(w.t.map, U.atk)) +
      '</div>' +
      (isFinite(w.dps) === false && w.pr ? '<div class="wnote">提示：没有找到开火间隔（炮塔 delay / 攻击 shootDelay），无法估算 DPS。</div>' : '') +
      (p && num(p.areaDamage) > 0 && !p.areaRadius ? '<div class="wnote">填了范围伤害但没写 areaRadius，范围杀伤不会生效范围大小默认为 0。</div>' : '') +
      '</div>';
  }).join('') : '<div class="wcard" style="border-left-color:var(--txt3)"><h4>没有炮塔</h4>' +
      '<div class="wnote" style="color:var(--txt3)">如果这个单位要攻击，需要 [attack] 段 + 至少一个 [turret_1] 段（炮塔）与 [projectile_1] 段（抛射体）。</div></div>';

  // ---- 数值卡
  const mvTxt = (U.mv.moveSpeed ? num(U.mv.moveSpeed) + ' 格/秒 左右' : '未设置');
  $('#fxStats').innerHTML = [
    card('造价', price || '—', 'credits', price > 0 ? '' : price < 0 ? 'r' : 'miss'),
    card('建造时间', isFinite(buildS) ? round1(buildS) : '—', '秒', isFinite(buildS) ? '' : 'miss'),
    card('生命值', hp || '—', '', hp > 0 ? 'g' : 'miss'),
    card('护盾', c.maxShield != null ? sh : '—', '', c.maxShield != null ? 'b' : 'miss'),
    card('护盾恢复', c.shieldRegen != null ? c.shieldRegen + ' /帧' : '—', '', c.shieldRegen != null ? 'b' : 'miss'),
    card('自身回血', c.selfRegenRate != null ? c.selfRegenRate + ' /帧' : '—', '', c.selfRegenRate != null ? 'g' : 'miss'),
    card('体积半径', radius, '像素', radius > 0 ? 'acc' : 'miss'),
    card('质量', num(c.mass) || '—', '', num(c.mass) > 0 ? '' : 'miss'),
    card('移动速度', U.mv.moveSpeed ? num(U.mv.moveSpeed) : '—', '格/秒', U.mv.moveSpeed ? '' : 'miss'),
    card('攻击距离', U.atk.maxAttackRange ? num(U.atk.maxAttackRange) : '—', '格', U.atk.maxAttackRange ? 'r' : 'miss'),
    card('视野', c.fogOfWarSightRange ? num(c.fogOfWarSightRange) : '—', '格', c.fogOfWarSightRange ? '' : 'miss'),
    card('护甲', c.armour || '—', '减伤%', c.armour ? 'acc' : 'miss'),
    card('图像', U.gfx.image || '—', '', U.gfx.image ? 'g' : 'miss'),
    card('死亡贴图', deadSet ? deadRef : '未设置', '', deadSet ? 'g' : 'miss'),
    card('段数', S.doc.sections.length, '', ''),
    card('字段数', S.doc.sections.reduce((a, s) => a + s.entries.filter(e => e.kind === 'field').length, 0), '', '')
  ].join('');

  drawCanvas(U);
  renderFxPreview(U);
  if (typeof renderAnimCards === 'function') renderAnimCards();
}

function attackTargets(tmap, amap) {
  const get = (k) => {
    const v = tmap[k] != null ? tmap[k] : amap[k];
    if (v == null || v === '') return null;
    return /^true$/i.test(v);
  };
  const fly = get('canAttackFlyingUnits'), land = get('canAttackLandUnits'), water = get('canAttackUnderwaterUnits');
  const list = [];
  if (fly) list.push('空中');
  if (land) list.push('地面');
  if (water) list.push('水下');
  if (!list.length) return '未指定';
  return list.join(' / ');
}
function cell(k, v) { return '<div><b>' + esc(k) + '</b><span>' + esc(v == null ? '—' : v) + '</span></div>'; }
function card(k, v, u, cls) {
  return '<div class="stat-card ' + (cls || '') + '"><div class="sk">' + esc(k) + '</div>' +
    '<div class="sv">' + esc(v) + (u ? '<small>' + esc(u) + '</small>' : '') + '</div></div>';
}
function round1(x) { return Math.round(x * 10) / 10; }
function barsHtml(c, hp, sh, buildS, price) {
  const maxRef = Math.max(hp, sh, 1);
  const rows = [];
  rows.push('<div class="bar-row"><span class="bl">生命</span><span class="bar hp"><i style="width:' +
    Math.max(2, hp / maxRef * 100) + '%"></i></span><span class="bv">' + (hp || '未填') + '</span></div>');
  if (c.maxShield != null)
    rows.push('<div class="bar-row"><span class="bl">护盾</span><span class="bar sh"><i style="width:' +
      Math.max(2, sh / maxRef * 100) + '%"></i></span><span class="bv">' + sh + '</span></div>');
  if (c.energyMax != null)
    rows.push('<div class="bar-row"><span class="bl">能量</span><span class="bar en"><i style="width:' +
      Math.min(100, num(c.energyStartingPercentage, 100)) + '%"></i></span><span class="bv">' + num(c.energyMax) + '</span></div>');
  const hours = isFinite(buildS) ? buildS : 0;
  rows.push('<div class="bar-row"><span class="bl">造价</span><span class="bar en"><i style="width:' +
    Math.min(100, Math.max(2, (price || 0) / 500 * 100)) + '%"></i></span>' +
    '<span class="bv">' + (price || 0) + ' / ' + (hours ? hours + 's' : '—') + '</span></div>');
  return '<div class="fx-bars">' + rows.join('') + '</div>';
}

/* ============================================================
   整机部件：主体 + 炮塔 + 附属(子单位) + 腿脚/胳膊 + 贴花
   ============================================================ */
const UNIT_IMG_CACHE = {};      // 单位名 → 贴图引用（在别的文件里）

/** 找某个“单位名”的贴图引用：先在模组索引里找文件，再读它的 [graphics] image */
function lookupUnitImageAsset(unitName, cb) {
  if (!unitName) { cb(null); return; }
  if (UNIT_IMG_CACHE[unitName] !== undefined) { cb(UNIT_IMG_CACHE[unitName]); return; }
  UNIT_IMG_CACHE[unitName] = null;
  const hit = ((S.scan && S.scan.units) || []).find(u => u.name === unitName);
  if (!hit || !hit.rel) { cb(null); return; }
  const full = (S.scan.root || '').replace(/[\\/]+$/, '') + '\\' + hit.rel;
  fetch('/api/file/load?path=' + encodeURIComponent(full)).then(r => r.json()).then(d => {
    if (d.error || d.text == null) { cb(null); return; }
    const g = (parseIni(d.text).find(x => deriveSecId(x.name) === 'graphics') || { entries: [] });
    const kv = {};
    for (const e of g.entries) if (e.key) kv[e.key] = e.value;
    const res = { image: kv.image || '', iniPath: full, path: full };
    UNIT_IMG_CACHE[unitName] = res;
    if (res.image) { resolveRef(res.image, null, full); redrawSprites(); }
    cb(res);
  }).catch(() => { UNIT_IMG_CACHE[unitName] = null; cb(null); });
}

/** 收集这个单位所有可见部件（按绘制层级排序，layer 小的先画） */
function unitVisualParts() {
  const g = firstSecMap('graphics');
  const nFrames = Math.max(1, num(g.total_frames, 1));
  const parts = [];
  for (const s of S.doc.sections) {
    const id = deriveSecId(s.name);
    const nm = String(s.name).replace(/^\[|\]$/g, '');
    const kv = {};
    for (const e of s.entries) if (e.key) kv[e.key] = e.value;
    if (id === 'leg_#') {
      const isArm = /^arm/i.test(nm);
      const mx = num(kv.x, 0), my = num(kv.y, 0);
      const ax = num(kv.attach_x, 0), ay = num(kv.attach_y, 0);
      const off = num(kv.drawDirOffset, num(kv.idleDir, 0));
      // 从附着点到脚的连线角度，让“腿”看起来是连着的
      const ang = (mx !== ax || my !== ay) ? Math.atan2(my - ay, mx - ax) * 180 / Math.PI : 0;
      const midImg = kv.image_middle || kv.image_leg;
      const endImg = kv.image_foot || kv.image_end;
      const label = (isArm ? '胳膊' : '腿') + nm.replace(/^[a-z_]*/i, '');
      // drawOverBody：腿/胳膊默认 false（画在主体之下），true 才画在主体之上
      const over = /^true$/i.test(String(kv.drawOverBody || ''));
      const baseLayer = over ? 38 : 12;
      if (midImg) parts.push({ layer: baseLayer, image: midImg, x: (ax + mx) / 2, y: (ay + my) / 2,
        dir: off, kind: isArm ? 'arm' : 'leg', label: label });
      if (endImg) parts.push({ layer: baseLayer + 1, image: endImg, x: mx, y: my,
        dir: off + (midImg ? ang : 0), kind: isArm ? 'arm' : 'leg', label: label });
    } else if (id === 'turret') {
      if (/^true$/i.test(String(kv.invisible || ''))) continue;
      const idx = num((nm.match(/(\d+)$/) || [])[1], 0);
      const img = kv.image || g.image_turret;
      if (!img) continue;
      // drawOverBody：炮塔默认 true（画在主体之上），false 才画在主体之下
      const over = !/^false$/i.test(String(kv.drawOverBody == null ? 'true' : kv.drawOverBody));
      parts.push({ layer: over ? 36 : 24, image: img, x: num(kv.x, 0), y: num(kv.y, 0),
        dir: num(kv.idleDir, 0), kind: 'turret', label: '炮塔' + idx,
        frame: (nFrames > 1 && !kv.image) ? idx % nFrames : 0, frames: nFrames });
    } else if (id === 'attachment') {
      if (/^true$/i.test(String(kv.hidden || ''))) continue;
      if (kv.isVisible !== undefined && !/^true$/i.test(String(kv.isVisible))) continue;
      const unit = String(kv.onCreateSpawnUnitOf || '').replace(/\(.*$/, '').trim();
      if (!unit) continue;
      parts.push({ layer: 34, unitRef: unit, x: num(kv.x, 0), y: num(kv.y, 0),
        dir: num(kv.idleDir, 0), kind: 'attachment', label: '附属 ' + unit });
    } else if (id === 'decal') {
      const L = { shadow: 6, beforeBody: 20, afterBody: 36, onTop: 44, beforeUI: 45 }[String(kv.layer || 'afterBody')];
      if (L == null) continue;                       // inactive / 未指定
      if (!kv.image) continue;
      parts.push({ layer: L, image: kv.image, x: num(kv.xOffsetRelative, 0), y: num(kv.yOffsetRelative, 0),
        dir: num(kv.dirOffset, 0), kind: 'decal', label: '贴花 ' + nm.replace(/^decal_/i, ''),
        frames: Math.max(1, num(kv.total_frames, 1)), fw: num(kv.frame_width, 0), fh: num(kv.frame_height, 0) });
    }
  }
  // 主体
  if (g.image) parts.push({ layer: 26, image: g.image, x: 0, y: 0, dir: 0, kind: 'body',
    label: '主体', isBody: true, frames: nFrames, fw: num(g.frame_width, 0), fh: num(g.frame_height, 0) });
  parts.sort((a, b) => a.layer - b.layer);
  return parts;
}

/* --------- 单位预览：正常 / 死亡贴图切换 --------- */
function syncFxStateButtons() {
  const st = S.ui.fxState === 'dead' ? 'dead' : 'normal';
  $$('.fx-state-btn').forEach(b => {
    const on = b.dataset.fxstate === st;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function setFxState(st) {
  S.ui.fxState = st === 'dead' ? 'dead' : 'normal';
  try { localStorage.setItem('rt_fx_state', S.ui.fxState); } catch (e) { /* 忽略 */ }
  syncFxStateButtons();
  renderEffect();
}

/* --------- 画布缩放：滚轮（以光标为中心）+ 拖拽平移 + 按钮 --------- */
let _fxRaf = false;
function fxScheduleRender() {
  if (_fxRaf) return;
  _fxRaf = true;
  requestAnimationFrame(() => { _fxRaf = false; renderEffect(); });
}
function bindFxZoom() {
  $$('.fx-state-btn').forEach(b => { b.onclick = () => setFxState(b.dataset.fxstate); });
  syncFxStateButtons();
  const cv = $('#fxCanvas');
  if (cv && !cv.dataset.zoomBound) {
    cv.dataset.zoomBound = '1';
    cv.addEventListener('wheel', ev => {
      ev.preventDefault();
      const r = cv.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const oldZ = S.ui.canvasZoom || 1;
      const f = ev.deltaY < 0 ? 1.18 : 1 / 1.18;
      const nz = Math.min(20, Math.max(0.2, oldZ * f));
      if (nz === oldZ) return;
      // 让光标下的那个点保持在光标下
      const W = cv.clientWidth, H = cv.clientHeight;
      const base = S.ui.baseScale || 1;
      const cx = W / 2 + (S.ui.canvasPan.x || 0), cy = H / 2 + (S.ui.canvasPan.y || 0);
      const wx = (mx - cx) / (base * oldZ), wy = (my - cy) / (base * oldZ);
      S.ui.canvasPan = { x: mx - W / 2 - wx * base * nz, y: my - H / 2 - wy * base * nz };
      S.ui.canvasZoom = nz;
      const zl = $('#fxZoomVal');
      if (zl) zl.textContent = Math.round(nz * 100) + '%';
      fxScheduleRender();
    }, { passive: false });
    let drag = null;
    cv.addEventListener('mousedown', ev => {
      drag = { x: ev.clientX, y: ev.clientY, px: S.ui.canvasPan.x || 0, py: S.ui.canvasPan.y || 0 };
      cv.classList.add('dragging');
    });
    window.addEventListener('mousemove', ev => {
      if (!drag) return;
      S.ui.canvasPan = { x: drag.px + ev.clientX - drag.x, y: drag.py + ev.clientY - drag.y };
      fxScheduleRender();
    });
    window.addEventListener('mouseup', () => { drag = null; cv.classList.remove('dragging'); });
    cv.addEventListener('dblclick', () => {
      S.ui.canvasZoom = 1; S.ui.canvasPan = { x: 0, y: 0 };
      const zl = $('#fxZoomVal');
      if (zl) zl.textContent = '100%';
      fxScheduleRender();
    });
  }
  const upd = () => { const el = $('#fxZoomVal'); if (el) el.textContent = Math.round((S.ui.canvasZoom || 1) * 100) + '%'; };
  $('#fxZoomIn').onclick = () => {
    S.ui.canvasZoom = Math.min(20, (S.ui.canvasZoom || 1) * 1.3); upd(); renderEffect();
  };
  $('#fxZoomOut').onclick = () => {
    S.ui.canvasZoom = Math.max(0.2, (S.ui.canvasZoom || 1) / 1.3); upd(); renderEffect();
  };
  $('#fxZoomReset').onclick = () => {
    S.ui.canvasZoom = 1; S.ui.canvasPan = { x: 0, y: 0 }; upd(); renderEffect();
  };
}

/* --------- 画布：比例 / 攻击范围示意 --------- */
function drawCanvas(U) {
  const cv = $('#fxCanvas');
  const fit = fitCanvas(cv, isMobile() ? 1.35 : 1.72);
  const ctx = fit.ctx, W = fit.W, H = fit.H;
  const c = U.core;
  const deadOn = S.ui.fxState === 'dead';
  const deadRef = deathImageOf(U.gfx);
  const deadSet = hasDeathImage(U.gfx);
  const radius = Math.min(Math.max(1, num(c.radius, 12)), 600);
  // 攻击距离可能是 99999（等于全图），按上限 120 格画并注明
  const RAW_RANGE = num(U.atk.maxAttackRange, 0);
  const RANGE_CAP = 120;
  const rangeTiles = Math.min(RAW_RANGE, RANGE_CAP);
  const rangeClamped = RAW_RANGE > RANGE_CAP;
  const sightTiles = Math.min(num(c.fogOfWarSightRange, 0), RANGE_CAP);
  const showGrid = $('#fxGrid').checked, showRange = $('#fxRange').checked;
  const wantSprite = $('#fxSprite') && $('#fxSprite').checked;
  const wantCloseup = $('#fxCloseup') && $('#fxCloseup').checked;

  // ---- 第一遍：收集整机部件（主体+炮塔+附属+腿脚+贴花），解析贴图并算包围盒 ----
  let drewSprite = false;
  let extent = radius;              // 至少覆盖本体半径
  let partCount = 0;
  const drawList = [];
  // 死亡状态只画整张残骸图；没设置 image_wreak 时退回正常贴图并给出提示
  const turretCb = $('#fxTurrets');
  if (turretCb) {
    turretCb.disabled = !!(deadOn && deadSet);
    turretCb.title = (deadOn && deadSet) ? '死亡贴图是整张残骸图，不单独绘制炮塔' : '';
  }
  if (wantSprite) {
    const showTurrets = !$('#fxTurrets') || $('#fxTurrets').checked;
    let vparts;
    if (deadOn && deadSet) {
      vparts = [{ layer: 26, image: deadRef, x: 0, y: 0, dir: 0, kind: 'body',
        label: '死亡主体 image_wreak', isBody: true, frames: 1, fw: 0, fh: 0 }];
    } else {
      vparts = unitVisualParts().filter(p => showTurrets || p.kind !== 'turret');
    }
    partCount = vparts.length;
    for (const pt of vparts) {
      let iniPath = null;
      if (pt.unitRef) {
        // 附属：子单位贴图在别的文件里，按单位名找定义文件
        let res = UNIT_IMG_CACHE[pt.unitRef];
        if (res === undefined) { lookupUnitImageAsset(pt.unitRef, () => {}); res = null; }
        if (res && res.image) { iniPath = res.path; pt.image = res.image; }
        else continue;
      }
      const ref = pt.image;
      if (!ref || /^(NONE|AUTO)$/i.test(String(ref).trim())) continue;
      const r = ASSET_REF_CACHE[(iniPath || S.doc.path || '') + '|' + ref];
      if (!r) { resolveRef(ref, null, iniPath); continue; }
      if (r.kind !== 'file') continue;
      const sp = loadSprite(r.path);
      if (sp.state === 'ok') {
        const im = sp.img;
        let fw = pt.fw || 0, fh = pt.fh || 0;
        const fr = pt.frames || 1;
        if (fr > 1 && fw <= 0 && im.width >= fr && (im.width % fr === 0 || pt.isBody)) {
          fw = Math.floor(im.width / fr); fh = im.height;
        }
        const sw = fw > 0 ? fw : im.width, sh = fh > 0 ? fh : im.height;
        extent = Math.max(extent, Math.abs(pt.x) + sw / 2, Math.abs(pt.y) + sh / 2);
      } else {
        extent = Math.max(extent, Math.abs(pt.x) + 18, Math.abs(pt.y) + 18);
      }
      drawList.push({ pt: pt, sp: sp });
    }
  }
  S.ui.partCount = partCount;

  // ---- 世界尺度：先按范围圈算；范围圈会把机体挤成小点时进入特写 ----
  const rangeWorld = Math.max(rangeTiles * TILE * 2.25, sightTiles * TILE * 2.25, 1);
  let world = Math.max(radius * 2.6, 120);
  if (showRange) world = Math.max(world, rangeWorld);
  let closeupOn = false;
  if (wantCloseup && wantSprite && drawList.length && rangeWorld > extent * 3.2) {
    closeupOn = true;
    world = Math.max(extent * 2.4, 90);
  }
  const baseScale = Math.min(W, H) / world;
  const zoom = S.ui.canvasZoom || 1;
  const pan = S.ui.canvasPan || { x: 0, y: 0 };
  S.ui.baseScale = baseScale;
  const scale = baseScale * zoom;
  const cx = W / 2 + (pan.x || 0), cy = H / 2 + (pan.y || 0);
  const P = px => px * scale;
  const tNow = performance.now();

  ctx.clearRect(0, 0, W, H);
  // 背景
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0d141d'); g.addColorStop(1, '#0a0f15');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // 地块网格（缩放太小时自动加粗，避免画出几十万条线把画布刷成一片色）
  let gridTiles = 1;
  if (showGrid) {
    while (20 * scale * gridTiles < 9) gridTiles *= 2;
    const step = 20 * scale * gridTiles;
    const n = Math.min(400, Math.ceil(Math.max(W, H) / step) + 2);
    ctx.strokeStyle = 'rgba(62,200,255,.10)'; ctx.lineWidth = 1;
    for (let i = -n; i <= n; i++) {
      const x = cx + i * step, y = cy + i * step;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }
  // 攻击范围（特写时超出视野，不画）
  if (showRange && rangeTiles > 0 && !closeupOn) {
    ctx.beginPath(); ctx.arc(cx, cy, P(rangeTiles * TILE), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,95,109,.75)'; ctx.lineWidth = 2; ctx.setLineDash([7, 5]); ctx.stroke();
    ctx.fillStyle = 'rgba(255,95,109,.07)'; ctx.fill(); ctx.setLineDash([]);
    ctx.fillStyle = '#ff8a94'; ctx.font = '12px "Microsoft YaHei UI"';
    ctx.fillText('攻击 ' + (rangeClamped ? RAW_RANGE + ' 格·全图（按 ' + rangeTiles + ' 格画）' : rangeTiles + ' 格'),
      6, 16);
  }
  // 视野范围
  if (showRange && sightTiles > 0 && !closeupOn) {
    ctx.beginPath(); ctx.arc(cx, cy, P(sightTiles * TILE), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(62,200,255,.5)'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#3ec8ff'; ctx.font = '12px "Microsoft YaHei UI"';
    ctx.fillText('视野 ' + sightTiles + ' 格', cx + P(sightTiles * TILE) * .5, cy + P(sightTiles * TILE) * .72);
  }
  // 占地
  if (/(true)/i.test(c.isBuilding || '') && c.footprint) {
    const p = String(c.footprint).split(',').map(x => parseFloat(x));
    if (p.length === 4 && p.every(x => !isNaN(x))) {
      const [x1, y1, x2, y2] = p;
      ctx.fillStyle = 'rgba(255,176,46,.09)';
      ctx.strokeStyle = 'rgba(255,176,46,.65)'; ctx.lineWidth = 1.4;
      ctx.fillRect(cx + P(x1 * TILE), cy + P(y1 * TILE), P((x2 - x1) * TILE), P((y2 - y1) * TILE));
      ctx.strokeRect(cx + P(x1 * TILE), cy + P(y1 * TILE), P((x2 - x1) * TILE), P((y2 - y1) * TILE));
      ctx.fillStyle = '#ffb02e'; ctx.font = '11px "Microsoft YaHei UI"';
      ctx.fillText('占地快照 footprint', cx + P(x1 * TILE) + 4, cy + P(y1 * TILE) - 5);
    }
  }
  // 参考：标准坦克半径 20
  if (!closeupOn) {
    ctx.beginPath(); ctx.arc(cx, cy, P(20), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(160,180,200,.28)'; ctx.lineWidth = 1; ctx.setLineDash([2, 4]); ctx.stroke(); ctx.setLineDash([]);
  }

  // ---- 整机部件：按层级画出拼装结果（主体/炮塔/附属/腿脚/贴花） ----
  for (const it of drawList) {
    const pt = it.pt;
    const px = cx + pt.x * scale, py = cy - pt.y * scale;
    if (drawSpriteOn(ctx, it.sp, px, py, scale, pt.frames || 1, pt.fw || 0, pt.fh || 0, tNow,
      { dir: pt.dir, frame: pt.frame !== undefined ? pt.frame : 0, autoFrame: !!pt.isBody })) {
      drewSprite = true;
    }
  }
  if (closeupOn && drewSprite) {
    ctx.strokeStyle = 'rgba(62,200,255,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, extent * scale + 6, 0, Math.PI * 2); ctx.stroke();
  }

  // 本体半径圈（没有贴图时用填充圆示意）
  if (!drewSprite) {
    const grad = ctx.createRadialGradient(cx - radius * scale * .3, cy - radius * scale * .3, P(radius * .15), cx, cy, P(radius));
    grad.addColorStop(0, '#7fd6ff33'); grad.addColorStop(1, '#2b6cb022');
    ctx.beginPath(); ctx.arc(cx, cy, P(radius), 0, Math.PI * 2);
    ctx.fillStyle = grad; ctx.fill();
  }
  ctx.beginPath(); ctx.arc(cx, cy, P(radius), 0, Math.PI * 2);
  ctx.strokeStyle = drewSprite ? 'rgba(62,200,255,.55)' : '#3ec8ff';
  ctx.lineWidth = drewSprite ? 1.5 : 2; ctx.stroke();

  // 中心十字 & 半径标注
  ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy);
  ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8); ctx.stroke();
  ctx.fillStyle = '#9fb0c6'; ctx.font = '12px "Microsoft YaHei UI"';
  ctx.fillText('半径 ' + radius + 'px（' + round1(radius / TILE) + ' 格）', cx + P(radius) + 6, cy + P(radius) + 14);

  // 比例尺
  const barTiles = closeupOn ? 5 : 5;
  const barPx = barTiles * TILE * scale;
  if (barPx > 30 && barPx < W - 40) {
    ctx.strokeStyle = '#9fb0c6'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(16, H - 18); ctx.lineTo(16 + barPx, H - 18);
    ctx.moveTo(16, H - 23); ctx.lineTo(16, H - 13);
    ctx.moveTo(16 + barPx, H - 23); ctx.lineTo(16 + barPx, H - 13); ctx.stroke();
    ctx.fillStyle = '#9fb0c6'; ctx.font = '11px monospace';
    ctx.fillText(barTiles + ' 格 (' + barTiles * TILE + 'px)', 16, H - 24);
  }
  if (deadOn) {
    ctx.save();
    ctx.strokeStyle = deadSet ? 'rgba(255,95,109,.55)' : 'rgba(255,176,46,.6)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
    const dlabel = deadSet ? '死亡 · image_wreak' : '死亡 · 缺少 image_wreak';
    ctx.font = 'bold 11px "Microsoft YaHei UI"';
    const dw = ctx.measureText(dlabel).width;
    ctx.fillStyle = 'rgba(8,12,18,.78)';
    ctx.fillRect(W - dw - 24, 7, dw + 18, 21);
    ctx.fillStyle = deadSet ? '#ff8a94' : '#ffb02e';
    ctx.textAlign = 'right';
    ctx.fillText(dlabel, W - 15, 22);
    ctx.restore();
  }
  const nTurret = drawList.filter(it => it.pt.kind === 'turret').length;
  const stateTxt = deadOn
    ? (deadSet ? '💀 死亡贴图 image_wreak' : '⚠ 死亡状态：未设置 image_wreak，按正常贴图显示')
    : '正常贴图 image';
  $('#fxLegend').textContent = stateTxt + '　·　' + (closeupOn
    ? '整机特写（' + partCount + ' 个部件' + (nTurret ? '，炮塔 ' + nTurret : '') + '）· 范围圈超出视野，取消「整机特写」可看攻击/视野范围　·　'
    : (deadSet && deadOn ? '残骸贴图 1 张' : '整机贴图 ' + partCount + ' 个部件' + (nTurret ? '（炮塔 ' + nTurret + '）' : '')) + '　·　') +
    (gridTiles > 1 ? '1 网格 = ' + gridTiles + ' 格（' + (gridTiles * TILE) + ' 像素）' : '1 地块 = 20 像素') +
    '　·　虚线 = 参考半径 20px 的标准坦克' + (rangeClamped ? '　·　攻击距离已超全图，按 ' + RANGE_CAP + ' 格缩小显示' : '') +
    (zoom !== 1 ? '　·　🔍 缩放 ' + Math.round(zoom * 100) + '%' : '');
}


/* ============================================================
   9. 错误检查引擎
   ============================================================ */
function validate() {
  const iss = [];
  const add = (level, code, title, detail, section, key, short, fix) =>
    iss.push({ level, code, title, detail, section, key, short, fix });

  const U = collectUnits();
  const c = U.core;
  const coreSec = secOf('core')[0];
  const has = (obj, k) => obj[k] != null && String(obj[k]).trim() !== '';
  // dont_load / 模板文件：只做定义，不当作一个完整单位
  const notAUnit = /^true$/i.test(String(c.dont_load || '').trim())
    || /\.template$/i.test(S.doc.name || '')
    || secOf('template').length > 0;
  const lvlUnit = lv => notAUnit ? 'info' : lv;
  const unitNote = notAUnit ? '（这个文件是模板 / 写了 dont_load: true，不是完整单位，所以按提示处理）' : '';
  const isTplSection = (secId) => secId === 'template';

  // E001 缺少 [core]
  if (!coreSec) add('error', 'E001', '缺少 [core] 段', '每个单位必须有 [core] 段，否则游戏无法识别这个单位。', '[core]', null, '缺少 [core] 段');
  // E002 name
  if (coreSec && !has(c, 'name')) add(lvlUnit('error'), 'E002', '缺少 name（单位名）',
    notAUnit ? '这个文件写了 dont_load: true，看起来只是做定义/模板用，不当作单位加载，所以没有 name 也算正常。'
             : 'name 是单位的唯一标识，必须填写，中文也可以用。例：name: 我的坦克', '[core]', 'name', '缺少 name');
  if (has(c, 'name')) {
    if (/[:#\[\]]/.test(c.name)) add('error', 'E003', 'name 里有非法字符', '单位名不能包含 : # [ ] 等符号，这些会破坏 ini 解析。', '[core]', 'name', 'name 含非法字符');
    if (/\s{1,}$/.test(c.name)) add('warn', 'E004', 'name 结尾有多余空格', '建议去掉首尾空格，避免引用时对不上。', '[core]', 'name', 'name 有尾空格');
  }
  if (coreSec && !has(c, 'displayText')) add(lvlUnit('info'), 'E005', '建议填写 displayText（显示名称）', '没有 displayText 时游戏会用 name 作为显示名；中文名建议用 displayText 以免影响引用。', '[core]', 'displayText');

  // 逐段检查
  const seenSecNames = {};
  for (const sec of S.doc.sections) {
    const secId = deriveSecId(sec.name);
    const meta = S.byId[secId];
    if (seenSecNames[sec.name] != null) add('error', 'E010', '重复的段 [' + sec.name + ']', '同一个 ini 里出现两个同名段，后面的会覆盖前面的，容易出错。', sec.name, null, '重复段 ' + sec.name);
    seenSecNames[sec.name] = true;

    if (!meta) add('warn', 'E011', '代码表里没有 [' + secId + '] 这个段', '可能是自定义段（RW 允许），也可能是拼写错误。请核对段名。', sec.name, null, '未知段 ' + sec.name);
    if (!sec.entries.filter(e => e.kind === 'field').length)
      add('info', 'E012', '段 [' + sec.name + '] 里没有字段', '空段一般没有作用，可以删掉或补充代码。', sec.name, null);

    const seenKeys = {};
    for (const e of sec.entries) {
      if (e.kind !== 'field') continue;
      const k = e.key, v = String(e.value);
      const localMeta = fieldMetaLoose(secId, k);
      const globalHit = findKeyMeta(k);
      const fm = localMeta || (globalHit || [])[0]?.entry || null;
      const isAt = k.startsWith('@');   // @copyFromSection 之类的复制指令，任何段都允许

      if (seenKeys[k] != null) {
        // 细则在下面统一出：值完全相同 / 值不同
        seenKeys[k].push(v);
      } else {
        seenKeys[k] = [v];
      }

      if (!fm && !isAt) add(isTplSection(secId) ? 'info' : 'warn', 'E021', '未知代码 ' + k, '代码表里查不到这个键，可能是拼写错误或版本差异。', sec.name, k, k + ' 未登记');
      else if (!localMeta && !isAt) {
        const owners = Array.from(new Set((globalHit || []).map(x => x.secId)));
        add(isTplSection(secId) ? 'info' : 'warn', 'E022', '键 ' + k + ' 不属于 [' + secId + '] 段',
          owners.length ? ('代码表里 ' + k + ' 登记在 [' + owners.join('] / [') + '] 段，放这里可能不生效。') : ('代码表里这个键不在 [' + secId + '] 段登记。'),
          sec.name, k, k + ' 段不匹配');
      }
      if (!v.trim()) add(tLevel === 'info' ? 'info' : 'warn', 'E023', '键 ' + k + ' 没有填值', '空值行会被当成空字符串，可能导致解析出问题。', sec.name, k, k + ' 空值');

      // 类型检查（模板段里的字段是半成品，一律按“提示”处理）
      const kind = fm ? fm.kind : null;
      const tLevel = (isWildKey(fm) || isTplSection(secId)) ? 'info' : 'warn';
      if (kind === 'bool' && !/^(true|false|0|1|yes|no)$/i.test(v.trim())
          && !/^(if|select|and|or|not|\$)/i.test(v.trim()) && !looksLikeAsset(v))
        add(tLevel, 'E030', k + ' 应该是 true / false', '当前值「' + v + '」，布尔键一般填 true / false（有些键也接受 0 / 1 或 CUSTOM:特效名）。', sec.name, k, k + ' 不是布尔值');
      if ((kind === 'integer' || kind === 'float' || kind === 'logic-number' || kind === 'price')
          && !isNumber(v) && !looksLikeExpr(v) && !/^-?[\d.]+\s*(s|ms|帧)$/.test(v.trim())) {
        if (/^[A-Za-z_][\w./\-]*$/.test(v.trim()))
          add('info', 'E038', k + ' 填的是标识符而不是数字', '代码表把它登记为数字类型，但游戏里有些键也接受特殊值（例如 stripIndex 可以填 effects / shockwave）。确认一下是不是你要的。', sec.name, k);
        else
          add(tLevel, 'E031', k + ' 应该是数字', '当前值「' + v + '」不是纯数字。要写表达式可以用 self.xx、max(...)、${...} 这类写法。', sec.name, k, k + ' 不是数字');
      }
      if (kind === 'integer' && /^-?\d+\.\d+$/.test(v.trim()))
        add('info', 'E032', k + ' 是整数类型', '当前填了小数 ' + v + '，小数部分可能被忽略。', sec.name, k, k + ' 应为整数');
      if (kind === 'time' && !/^-?[\d.]+\s*(s|ms|帧)?$/.test(v.trim()))
        add(tLevel, 'E033', k + ' 时间格式不对', '时间写法：3s / 500ms / 60帧（直接写数字=秒）。当前：「' + v + '」', sec.name, k, k + ' 时间格式');
      if (kind === 'color' && !/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim()))
        add(tLevel, 'E034', k + ' 颜色格式不对', '颜色写法：#RRGGBB 或 #AARRGGBB，例如 #FF9D00FF。当前：「' + v + '」', sec.name, k, k + ' 颜色格式');
      if ((kind === 'tags' || kind === 'list') && /[，、;；]/.test(v))
        add('warn', 'E035', k + ' 列表要用英文逗号', '当前值里有中文逗号/顿号/分号，游戏只认英文逗号 ","。', sec.name, k, k + ' 逗号格式');
      if (kind === 'numlist') {
        const bad = v.split(/[,，]/).map(x => x.trim()).filter(Boolean).filter(x => !/^-?[\d.]+$/.test(x) && !/^\$/.test(x));
        if (bad.length) add('warn', 'E037', k + ' 应该是数字列表', '「' + bad.slice(0, 3).join('、') + '」不是数字（写法：左,上,右,下）。', sec.name, k, k + ' 数字列表');
        else if (/[，]/.test(v)) add('warn', 'E035', k + ' 列表要用英文逗号', '游戏只认英文逗号 ","。', sec.name, k, k + ' 逗号格式');
      }
      // 全角冒号
      if (e.cnColon) add('error', 'E036', '键 ' + k + ' 用了中文冒号', '必须用英文冒号 key: value，中文冒号「：」会让这一行在游戏里失效。导出时已自动帮你改成英文冒号。', sec.name, k, k + ' 中文冒号');
    }

    // 重复键：分成「值完全相同」和「值不同」两种
    for (const k in seenKeys) {
      const vals = seenKeys[k];
      if (vals.length < 2) continue;
      const allSame = vals.every(v => v === vals[0]);
      if (allSame) {
        add('warn', 'E024', '重复的键 ' + k + '（值完全相同）',
          '同一段里 ' + k + ' 写了 ' + vals.length + ' 次，值一模一样。删掉多余的完全没影响 —— ' +
          '错误检查面板顶部有「删去值完全相同的键」可以一键清掉。', sec.name, k, k + ' 重复(相同值)');
      } else {
        add('error', 'E020', '重复的键 ' + k + '（值不同）',
          '同一段里 ' + k + ' 写了 ' + vals.length + ' 次且值不一样（' + vals.map(v => '「' + v + '」').join('、') + '），' +
          '游戏只认最后一条，前面的都是白写 —— 可以用「重复键只留最后一条」一键清理。', sec.name, k, k + ' 重复(值不同)');
      }
    }

  }

  // 关键数值
  if (coreSec) {
    if (!has(c, 'maxHp')) add(lvlUnit('warn'), 'E040', '没有填 maxHp（生命值）', '没有生命值的单位出生就可能立即死亡。', '[core]', 'maxHp', '缺少 maxHp');
    else if (num(c.maxHp) <= 0) add('warn', 'E041', 'maxHp 必须大于 0', '当前 ' + c.maxHp, '[core]', 'maxHp', 'maxHp 无效');
    if (!has(c, 'radius')) add(lvlUnit('warn'), 'E042', '没有填 radius（半径）', '半径决定碰撞体积和选择范围，不填会很难点击。', '[core]', 'radius', '缺少 radius');
    else if (num(c.radius) <= 0) add('warn', 'E043', 'radius 是 0（或不是正数）', '半径为 0 的单位没有碰撞体积、也很难被点选。' +
      '如果你是要做纯效果/辅助单位，这样写可以忽略；否则请填实际半径。当前 ' + c.radius, '[core]', 'radius', 'radius 为 0');
    else if (num(c.radius) < 4) add('info', 'E044', 'radius 偏小（' + c.radius + 'px）', '小于 4 像素的单位几乎点不到，建议 ≥ 8。', '[core]', 'radius');
    if (!has(c, 'mass')) add(lvlUnit('info'), 'E045', '没有填 mass（质量）', '不填通常按 0 处理，单位会被别的东西随意推开。', '[core]', 'mass');
    else if (num(c.mass) <= 0) add('info', 'E046', 'mass 为 0 或负数', '单位之间会互相穿插推挤，建筑建议 2000 以上。', '[core]', 'mass');
    if (!has(c, 'price')) add('info', 'E047', '没有填 price（价格）', '不填按 0 处理（免费单位）。', '[core]', 'price');
    if (num(c.techLevel) && (num(c.techLevel) < 1 || num(c.techLevel) > 3))
      add('warn', 'E048', 'techLevel 建议 1~3', '当前 ' + c.techLevel + '，界面上的等级颜色只会区分 1 级与 2/3 级。', '[core]', 'techLevel', 'techLevel 异常');
    if (has(c, 'buildSpeed') && !isFinite(parseTimeS(c.buildSpeed)))
      add('warn', 'E049', 'buildSpeed 时间格式不对', '例：5s、1500ms、60帧。当前：「' + c.buildSpeed + '」', '[core]', 'buildSpeed', 'buildSpeed 格式');
    if (num(c.selfRegenRate) > 5) add('warn', 'E050', 'selfRegenRate 偏大', '这是每帧回血（60 帧=1 秒），填 ' + c.selfRegenRate + ' 相当于每秒 ' + num(c.selfRegenRate) * 60 + ' 点。', '[core]', 'selfRegenRate');
    if (num(c.shieldRegen) > 5) add('warn', 'E051', 'shieldRegen 偏大', '同样是每帧数值，' + c.shieldRegen + ' ≈ 每秒 ' + num(c.shieldRegen) * 60 + ' 点。', '[core]', 'shieldRegen');
    if (has(c, 'maxShield') && num(c.maxShield) > 0 && !has(c, 'shieldRegen'))
      add('info', 'E052', '有护盾但没有 shieldRegen', '护盾不会自动恢复，若非本意请补 shieldRegen。', '[core]', 'shieldRegen');
    if (has(c, 'copyFrom') && !/^(ROOT:|CUSTOM:|\$)/i.test(String(c.copyFrom).trim()))
      add('info', 'E053', 'copyFrom 路径建议用 ROOT:', '模板路径一般写成 ROOT:/通用特效/xxx.ini。当前：「' + c.copyFrom + '」', '[core]', 'copyFrom');
  }

  // 图形
  const gsec = secOf('graphics')[0];
  if (!gsec) add(lvlUnit('warn'), 'E060', '缺少 [graphics] 段', '没有图像段的单位在游戏里是隐形的。' + unitNote, '[graphics]', null, '缺少 [graphics]');
  else if (!has(U.gfx, 'image') || /^none$/i.test(String(U.gfx.image).trim()))
    add(lvlUnit('info'), 'E061', '没有设置 image（图像）', 'image: 你的图片.png，图片放在单位 ini 同目录，或用 ROOT:/ 指向模组根。', '[graphics]', 'image');
  else if (!/\.(png|jpg|jpeg)$/i.test(U.gfx.image) && !/^(AUTO|NONE)$/i.test(U.gfx.image.trim()))
    add('info', 'E062', 'image 不像图片文件名', '通常要写完整的文件名（含 .png）。当前：「' + U.gfx.image + '」', '[graphics]', 'image');

  // 移动
  const mvSec = secOf('movement')[0];
  const isBuilding = /^true$/i.test(c.isBuilding || '');
  if (!mvSec && !isBuilding) add(lvlUnit('warn'), 'E070', '缺少 [movement] 段', '不写移动段的单位无法移动（建筑可以没有）。' + unitNote, '[movement]', null, '缺少 [movement]');
  if (mvSec && !has(U.mv, 'movementType')) add(lvlUnit('warn'), 'E071', '没有填 movementType', '可填 NONE / LAND / BUILDING / AIR / WATER / HOVER / OVER_CLIFF 等。', '[movement]', 'movementType');
  if (mvSec && has(U.mv, 'movementType')) {
    const mt = String(U.mv.movementType).toUpperCase();
    const ok = ['NONE', 'LAND', 'BUILDING', 'AIR', 'WATER', 'HOVER', 'OVER_CLIFF', 'OVER_CLIFF_WATER', 'HOV', 'HOVER'];
    if (!ok.includes(mt)) add('warn', 'E072', 'movementType 值不认识', '当前「' + U.mv.movementType + '」，常用：LAND / BUILDING / AIR / WATER / HOVER。', '[movement]', 'movementType');
    if (mt === 'AIR' && /^true$/i.test(c.isBio || '')) add('info', 'E073', 'AIR 单位同时 isBio', '空中生物不太常见，确认是否笔误。', '[movement]', 'movementType');
    if (isBuilding && mt !== 'BUILDING' && mt !== 'NONE') add('info', 'E074', '建筑单位的 movementType 通常是 BUILDING', '当前是 ' + mt + '。', '[movement]', 'movementType');
  }

  // 攻击 / 炮塔 / 抛射体
  const atkSec = secOf('attack')[0];
  const turrets = U.turrets, projs = U.projectiles;
  const projectilesUsed = new Set();
  for (const t of turrets) {
    const pv = String(t.map.projectile == null ? '' : t.map.projectile).trim();
    const inherits = has(t.map, 'copyFrom') || has(t.map, '@copyFromSection');
    if (!pv) {
      if (!inherits) {
        // 炮塔没有 projectile：可能是纯粹当炮口/特效点用，也可能是漏写
        const onlyDecor = ['shoot_sound', 'shoot_sound_vol', 'image', 'invisible', 'x', 'y', 'size', 'height',
          'barrelX', 'barrelY', 'chargeEffectImage', 'onShoot_playAnimation', 'warmupStartEffect',
          'recoilOffset', 'recoilOutTime', 'spawnEffectsOnQueue'].some(k => has(t.map, k));
        const hasRealKeys = Object.keys(t.map).filter(k => k !== 'x' && k !== 'y').length > 0;
        if (!hasRealKeys)
          add(lvlUnit('error'), 'E080', '[' + t.name + '] 没有填 projectile', '炮塔必须用 projectile: 序号 指定要发射的抛射体，否则这个炮塔是空的。', t.name, 'projectile', t.name + ' 缺 projectile');
        else
          add(lvlUnit('warn'), 'E080', '[' + t.name + '] 没有填 projectile', onlyDecor
            ? '这个炮塔没有指定抛射体。如果它只是炮口/特效点（靠撞上去或动作来造成伤害）可以忽略；否则要补 projectile: 序号。'
            : '炮塔没有指定 projectile: 序号，这个炮塔不会开火。', t.name, 'projectile', t.name + ' 缺 projectile');
      }
    } else {
      projectilesUsed.add(pv);
      const hit = projs.find(p => String(p.idx) === pv || p.name.replace(/^projectile_?/i, '') === pv || p.name === pv);
      if (!hit) add('error', 'E081', '找不到抛射体 [projectile_' + pv + ']', '[' + t.name + '] 引用了 projectile: ' + pv + '，但文件里没有对应段。', t.name, 'projectile', '缺少 projectile_' + pv);
    }
    const ti = num(String(t.name).match(/(\d+)\s*$/)?.[1], 0);
    if (ti > 31) add('info', 'E082', '炮塔序号超过 31（只是风格建议）',
      '代码表说炮塔序号"非必要请填 1-31 的数字"，但实际用更大的数字（如 turret_233）在游戏里也能正常工作，只是可读性差些。', t.name, null);
    if (t.map.delay != null && !isNumber(t.map.delay) && !/^-?[\d.]+\s*(s|ms|帧)$/.test(String(t.map.delay).trim()) && !looksLikeExpr(t.map.delay))
      add(lvlUnit('warn'), 'E083', t.name + ' 的 delay 不是数字', '开火间隔直接写数字=帧（60 帧 = 1 秒），也可以写 2.2s 这种时间。', t.name, 'delay');
    if (!has(t.map, 'x') || !has(t.map, 'y')) add('info', 'E084', t.name + ' 没写 x / y', '不写炮塔会落在单位中心，多炮塔时容易重叠。', t.name, 'x');
  }
  for (const p of projs) {
    const pIdx = String(p.idx);
    if (!projectilesUsed.has(pIdx) && !projectilesUsed.has(p.name) && !projectilesUsed.has(p.name.replace(/^projectile_?/i, '')))
      add('info', 'E085', '抛射体 ' + p.name + ' 没有被任何炮塔使用', '要么把炮塔的 projectile 指向它，要么删掉它。', p.name, null);
    if (num(p.map.areaDamage) > 0 && !has(p.map, 'areaRadius'))
      add(lvlUnit('warn'), 'E086', p.name + ' 有范围伤害但没有 areaRadius', '不写半径就没有溅射范围。', p.name, 'areaRadius', p.name + ' 缺 areaRadius');
    if (p.map.instant !== 'true' && has(p.map, 'speed') && num(p.map.speed) <= 0)
      add(lvlUnit('warn'), 'E087', p.name + ' 的 speed 为 0', '非 instant 抛射体速度必须大于 0，否则子弹不会飞。', p.name, 'speed');
    if (p.map.instant !== 'true' && !has(p.map, 'speed'))
      add('info', 'E088', p.name + ' 没有填 speed', '非瞬发抛射体不填速度可能飞不动。', p.name, 'speed');
    if (!has(p.map, 'directDamage') && !has(p.map, 'areaDamage') && !has(p.map, 'spawnUnit'))
      add('info', 'E089', p.name + ' 没有任何伤害', 'directDamage / areaDamage 都没填，这个武器打不出伤害。', p.name, 'directDamage');
  }
  if (atkSec) {
    const canAtk = !/^false$/i.test(U.atk.canAttack == null ? 'true' : U.atk.canAttack);
    const inheritsAtk = has(U.atk, 'copyFrom') || has(c, 'copyFrom');
    if (canAtk && !turrets.length) add(inheritsAtk ? 'info' : 'warn', 'E090', '可以攻击但没有炮塔',
      inheritsAtk ? '这个单位用 copyFrom 继承了模板，炮塔可能来自模板，这里没有本地定义。' : '[attack] 里 canAttack 不是 false，但没有任何 [turret_N] 段。',
      '[attack]', 'canAttack', '没有炮塔');
    if (!canAtk && turrets.length) add('info', 'E091', 'canAttack: false 但定义了炮塔', '定义了炮塔但整体禁止攻击，炮塔不会开火。', '[attack]', 'canAttack');
    if (canAtk) {
      const anyTarget = turrets.some(t => {
        const g = k => (t.map[k] != null && t.map[k] !== '') ? /^true$/i.test(t.map[k]) : /^true$/i.test(U.atk[k] || '');
        return g('canAttackFlyingUnits') === false && g('canAttackLandUnits') === false && g('canAttackUnderwaterUnits') === false ? false : true;
      });
      if (!anyTarget) add(inheritsAtk ? 'info' : 'warn', 'E092', '打不了任何目标',
        (inheritsAtk ? '本地没写能打什么目标，可能由 copyFrom 模板决定；' : '') + 'canAttackFlyingUnits / canAttackLandUnits / canAttackUnderwaterUnits 全是 false 时武器会一直不开火。', '[attack]', 'canAttack');
    }
    if (canAtk && num(U.atk.maxAttackRange) <= 0) add(lvlUnit('warn'), 'E093', 'maxAttackRange 不是正数', '当前 ' + (U.atk.maxAttackRange || '未填') + '，攻击距离为 0 就打不到任何东西。', '[attack]', 'maxAttackRange');
  } else if (turrets.length) {
    add(lvlUnit('warn'), 'E094', '有炮塔但没有 [attack] 段', '炮塔需要在 [attack] 段里开启攻击相关设置。', '[attack]', null, '缺少 [attack]');
  }

  // 建造
  const cbSecs = secOf('canBuild');
  const isBuilder = /^true$/i.test(c.isBuilder || '') || /^true$/i.test(U.mv.useAsBuilder || '') || /^true$/i.test(firstSecMap('ai').useAsBuilder || '');
  if (isBuilder && !cbSecs.length) add(has(c, 'copyFrom') ? 'info' : 'warn', 'E100', '是建造者但没有 [canBuild_N] 段',
    has(c, 'copyFrom') ? '这个单位用 copyFrom 继承了模板，建造列表可能来自模板；如果本地就要能建造东西，补 [canBuild_数字] 段。'
                       : '建造者需要通过 [canBuild_数字] 段指定能造什么。', '[canBuild]', null, '缺少 canBuild');
  cbSecs.forEach((s, i) => {
    const m = {};
    for (const e of s.entries) if (e.key) m[e.key] = e.value;
    if (!has(m, 'name')) add('error', 'E101', '[' + s.name + '] 没有填 name', 'canBuild 段的 name 是要建造的目标单位名。', s.name, 'name', s.name + ' 缺 name');
    if (!has(m, 'pos')) add('info', 'E102', '[' + s.name + '] 没有填 pos（排序）', 'pos 决定这个建造项在建造列表里的位置。', s.name, 'pos');
    if (/^true$/i.test(m.isLocked || '')) add('info', 'E103', '[' + s.name + '] 被锁定 isLocked: true', '锁定项玩家点不了，需要别的方式解锁（如解锁动作）。', s.name, 'isLocked');
  });

  // 建筑
  if (isBuilding) {
    if (!has(c, 'footprint')) add('info', 'E110', '建筑没有填 footprint（占地）', '写法：-3,-3,3,3（左,上,右,下）。不填时游戏按内置逻辑估算，想精确控制占地大小就补上。', '[core]', 'footprint');
    else {
      const p = String(c.footprint).split(',').map(x => parseFloat(x));
      if (p.length !== 4 || p.some(x => isNaN(x))) add('error', 'E111', 'footprint 格式不对', '必须是 4 个数字：左,上,右,下，如 -3,-3,3,3。当前：「' + c.footprint + '」', '[core]', 'footprint', 'footprint 格式');
      else if (p[0] >= p[2] || p[1] >= p[3]) add('error', 'E112', 'footprint 左右/上下反了', '必须满足 左<右、上<下。当前：「' + c.footprint + '」', '[core]', 'footprint');
      else {
        const w = (p[2] - p[0]) * TILE, h = (p[3] - p[1]) * TILE;
        if (w > 0 && h > 0 && num(c.radius) > 0 && num(c.radius) * 2 > Math.max(w, h) * 1.4)
          add('info', 'E113', 'radius 比占地大很多', '半径 ' + c.radius + 'px 超过占地 ' + w + '×' + h + 'px，选择范围会溢出建筑外形。', '[core]', 'radius');
      }
    }
  }

  // 其他段
  const resSecs = secOf('resource').concat(secOf('global_resource'));
  resSecs.forEach(s => {
    const m = {};
    for (const e of s.entries) if (e.key) m[e.key] = e.value;
    if (!has(m, 'displayName')) add('info', 'E120', '[' + s.name + '] 建议填 displayName', '没有显示名称的资源在 HUD 里显示为空白。', s.name, 'displayName');
    if (has(m, 'displayColor') && !/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(m.displayColor.trim()))
      add('warn', 'E121', '[' + s.name + '] displayColor 格式不对', '例：#FF9D00FF（AARRGGBB）。', s.name, 'displayColor');
  });

  // 段顺序提示（core 必须在最前？RW 不强制，但推荐）
  if (coreSec && S.doc.sections[0] !== coreSec)
    add('info', 'E130', '[core] 不在最前面', '游戏允许任意顺序，但把 [core] 放最前更符合习惯，也便于阅读。', '[core]', null);

  // 悬空引用（需要扫描过模组才能确定“模组里也没有”）
  if (S.scan && S.scan.ok) {
    for (const m of missingRefs()) {
      if (m.level !== 'warn') continue;
      const KIND = { effect: '特效', action: '动作', unit: '单位', global: '全局变量', asset: '素材' };
      const CODE = { effect: 'E140', action: 'E141', unit: 'E142', global: 'E143', asset: 'E144' };
      const from = m.from[0] || {};
      add('warn', CODE[m.kind] || 'E149',
        '找不到' + (KIND[m.kind] || m.kind) + '「' + m.name + '」',
        '代码里引用了它，但本文件和整个模组里都没找到定义。' +
        (m.kind === 'effect' ? '特效一般是 [effect_' + m.name + '] 段，或在其它文件里定义。' : '') +
        (m.kind === 'asset' ? '素材文件（图片/音效）需要在模组目录里存在。' : ''),
        from.sec || '', from.key || null, '找不到' + (KIND[m.kind] || '') + ' ' + m.name);
    }
  }

  // 排序：错误 > 警告 > 提示
  const order = { error: 0, warn: 1, info: 2 };
  iss.sort((a, b) => order[a.level] - order[b.level]);
  return iss;
}

function renderCheck() {
  renderDupBar();
  renderDupDetails();
  const iss = S.ui.issues;
  const n = { error: 0, warn: 0, info: 0 };
  iss.forEach(i => n[i.level]++);
  $('#checkSum').innerHTML =
    (n.error ? '<span class="pill e">错误 ' + n.error + '</span>' : '') +
    (n.warn ? '<span class="pill w">警告 ' + n.warn + '</span>' : '') +
    (n.info ? '<span class="pill i">提示 ' + n.info + '</span>' : '') +
    (!iss.length ? '<span class="pill ok">✓ 没有发现问题，可以直接用</span>' : '') +
    (iss.length ? '<span style="color:var(--txt3);font-size:11.5px">点击条目可定位到字段</span>' : '');

  const ICON = { error: '✖', warn: '⚠', info: 'ℹ' };
  $('#checkList').innerHTML = iss.length ? iss.map((i, idx) =>
    '<div class="issue ' + i.level[0] + '" data-issue="' + idx + '">' +
    '<div class="it"><span class="icode">' + i.code + '</span>' + ICON[i.level] + ' ' + esc(i.title) + '</div>' +
    '<div class="id">' + esc(i.detail) + '</div>' +
    (i.section ? '<div class="loc">位置：' + esc(i.section) + (i.key ? ' → ' + esc(i.key) : '') + '</div>' : '') +
    '</div>').join('')
    : '<div class="issue i" style="cursor:default"><div class="it">✓ 检查通过</div>' +
      '<div class="id">没有发现明显问题。发布前建议把生成的代码粘进游戏里跑一次，确认实际效果。</div></div>';

  $('#checkList').onclick = ev => {
    const d = ev.target.closest('[data-issue]');
    if (!d) return;
    const i = iss[parseInt(d.dataset.issue, 10)];
    if (!i) return;
    switchTab('code');
    if (isMobile()) switchMobileView('edit');
    if (i.section && i.key) {
      const sec = S.doc.sections.find(s => s.name === i.section || deriveSecId(s.name) === i.section);
      if (sec) { sec.collapsed = false; renderEditor(); focusField(deriveSecId(sec.name), i.key); }
      else { toast('这个字段还没加到编辑区：<b>' + esc(i.key) + '</b>', '', 3000); }
    } else if (i.section) {
      const el = document.querySelector('.sec-card[data-secid="' + cssEsc(i.section.replace(/^\[|\]$/g, '')) + '"]');
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('sec-flash'); setTimeout(() => el.classList.remove('sec-flash'), 1300); }
    }
  };

  const badge = $('#errBadge');
  badge.textContent = n.error + n.warn;
  badge.classList.toggle('zero', (n.error + n.warn) === 0);
  const st = $('#stIssue');
  if (n.error) { st.textContent = '✖ ' + n.error + ' 个错误 · ' + n.warn + ' 个警告'; st.className = 'bad'; }
  else if (n.warn) { st.textContent = '⚠ ' + n.warn + ' 个警告'; st.className = ''; st.style.color = 'var(--yellow)'; }
  else { st.textContent = '✓ 检查通过'; st.className = 'ok'; st.style.color = ''; }
}

/* ============================================================
   10. 参考手册
   ============================================================ */
function renderRefTools() {
  const sel = $('#refSelect');
  const opts = ['<option value="__groups">代码表 · 分段速查</option>'];
  Object.keys(S.meta.enums).forEach(k =>
    opts.push('<option value="enum:' + esc(k) + '">参考值 · ' + esc(S.meta.enums[k].title) + '</option>'));
  S.meta.reference_blocks.forEach((b, i) => {
    if (Object.values(S.meta.enums).some(e => e === b)) return;
    opts.push('<option value="blk:' + i + '">参考值表 · ' + esc(b.title) + '</option>');
  });
  opts.push('<option value="map">地图代码表</option>');
  sel.innerHTML = opts.join('');
  sel.onchange = renderRef;
  $('#refFilter').oninput = debounce(renderRef, 180);
  renderRef();
}
function renderRef() {
  const v = $('#refSelect').value, q = $('#refFilter').value.trim().toLowerCase();
  const body = $('#refBody');
  const flt = items => q ? items.filter(i => (i.v + ' ' + (i.t || '')).toLowerCase().includes(q)) : items;

  if (v === '__groups') {
    body.innerHTML = S.meta.sections.map(s =>
      '<h3>' + esc(s.raw) + '　' + esc(s.title) + '</h3>' +
      '<table class="ref-tbl"><tr><th>代码</th><th>中文</th><th>类型</th><th>说明</th></tr>' +
      s.groups.flatMap(g => g.entries.map(e =>
        '<tr><td class="k">' + esc(e.code) + '</td><td>' + esc(e.trans) + '</td><td>' + esc(e.vtype || '') +
        '</td><td class="t">' + esc((e.desc || '').slice(0, 140)) + '</td></tr>')).join('') +
      '</table>').join('');
    return;
  }
  if (v.startsWith('enum:') || v.startsWith('blk:')) {
    let blk, title;
    if (v.startsWith('enum:')) { blk = S.meta.enums[v.slice(5)]; title = blk.title; }
    else { blk = S.meta.reference_blocks[parseInt(v.slice(4), 10)]; title = blk.title; }
    if (!blk) { body.innerHTML = '<div class="no-result">没有数据</div>'; return; }
    const items = flt(blk.items);
    body.innerHTML = '<h3>' + esc(title) + '　<span style="color:var(--txt3);font-size:12px">共 ' + items.length + ' 项</span></h3>' +
      '<table class="ref-tbl"><tr><th>可填值</th><th>含义</th></tr>' +
      items.map(i => '<tr><td class="k">' + esc(i.v) + '</td><td class="t">' + esc(i.t || '') + '</td></tr>').join('') +
      '</table>';
    return;
  }
  if (v === 'map') {
    const rows = S.meta.mapCodes.filter(r => !q || r.join(' ').toLowerCase().includes(q));
    body.innerHTML = '<h3>地图代码表（Tiled 图层 / 地图设置）</h3>' +
      '<table class="ref-tbl">' + rows.slice(0, 400).map(r =>
        '<tr>' + r.slice(0, 4).map((c, i) => '<td class="' + (i === 0 ? 'k' : 't') + '">' + esc(c).replace(/\n/g, '<br>') + '</td>').join('') + '</tr>').join('') +
      '</table>';
    return;
  }
}

/* ============================================================
   11. 渲染总控
   ============================================================ */
function renderAll() {
  renderEditor();
  renderLib();
  renderPreviewAll();
  renderBagSelbar();
  renderBag();
  const core = secOf('core')[0];
  const nm = core ? (core.entries.find(e => e.key === 'name') || {}).value : '';
  $('#docTitle').textContent = '单位：' + (nm || '未命名');
  $('#fileName').textContent = S.doc.name + (S.doc.dirty ? ' *' : '');
}
function renderPreviewAll() {
  if (S.ui._missKey !== missCacheKey()) S.ui._miss = null;
  S.ui.issues = validate();
  renderCode();
  renderEffect();
  renderCheck();
  renderBagMiss();
  updateCounts();
}
function updateCounts() {
  const secs = S.doc.sections.length;
  const fields = S.doc.sections.reduce((a, s) => a + s.entries.filter(e => e.kind === 'field').length, 0);
  $('#chipStats').textContent = secs + ' 段 · ' + fields + ' 字段';
  $('#stCount').textContent = secs + ' 段 / ' + fields + ' 字段';
}
function switchTab(name) {
  S.ui.tab = name;
  if (isMobile() && name !== 'ref') switchMobileView('view');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $('#tabCode').classList.toggle('hidden', name !== 'code');
  $('#tabEffect').classList.toggle('hidden', name !== 'effect');
  $('#tabCheck').classList.toggle('hidden', name !== 'check');
  $('#tabRef').classList.toggle('hidden', name !== 'ref');
  $('#tabBag').classList.toggle('hidden', name !== 'bag');
  if (name === 'bag') { renderBag(); renderBagMiss(); }
  if (name === 'effect') renderEffect();
  if (typeof syncSidebarUI === 'function') syncSidebarUI();
}

/* ============================================================
   12. 弹窗
   ============================================================ */
function openModal(title, bodyHtml, footHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalFoot').innerHTML = footHtml || '<button class="btn" id="mClose">关闭</button>';
  $('#modalMask').classList.remove('hidden');
  const c = $('#mClose'); if (c) c.onclick = closeModal;
}
function closeModal() { $('#modalMask').classList.add('hidden'); }

/* ---- 添加字段弹窗 ---- */
function openAddFieldModal(sid) {
  const sec = S.doc.sections.find(s => s.id === sid);
  const secId = deriveSecId(sec.name);
  const meta = S.byId[secId];
  const used = new Set(sec.entries.map(e => e.key));
  let list = meta ? meta.groups.flatMap(g => g.entries.map(e => Object.assign({ _g: g.name }, e))) : [];
  const html =
    '<div class="form-row"><label>字段名</label>' +
    '<input id="afSearch" placeholder="搜索 / 或直接输入自定义键名" autocomplete="off"></div>' +
    '<div id="afList" style="max-height:430px;overflow:auto"></div>' +
    '<div class="form-row" style="margin-top:10px"><label>值</label><input id="afValue" value=""></div>' +
    '<div class="form-row"><label></label><span class="tip">选中列表项会自动填入；也可以直接填自定义键名</span></div>';
  openModal('给 [' + sec.name + '] 添加字段', html,
    '<button class="btn primary" id="afOk">添加</button><button class="btn" id="mClose">取消</button>');
  const draw = (q) => {
    const items = list.filter(e => !q || (e.code + e.trans + e.desc).toLowerCase().includes(q.toLowerCase()));
    $('#afList').innerHTML = items.length ? items.slice(0, 300).map(e =>
      '<div class="brow" data-code="' + esc(e.code) + '"><span class="bi">' +
      (used.has(e.code) ? '✓' : '＋') + '</span><span class="e-code">' + esc(e.code) + '</span>' +
      '<span class="e-trans">' + esc(e.trans) + '</span>' +
      '<span class="badge-t ' + badgeCls(e.kind || 'string') + '">' + esc(e.vtype || e.kind) + '</span></div>').join('')
      : '<div class="no-result">没有匹配；直接在上面输入键名也能添加</div>';
  };
  draw('');
  $('#afSearch').oninput = () => draw($('#afSearch').value);
  $('#afList').onclick = ev => {
    const b = ev.target.closest('.brow'); if (!b) return;
    $('#afSearch').value = b.dataset.code;
    const e = list.find(x => x.code === b.dataset.code);
    $('#afValue').value = suggestValue(e);
    draw(b.dataset.code);
  };
  $('#afOk').onclick = () => {
    const k = $('#afSearch').value.trim().replace(/[：:]\s*$/, '');
    if (!k) { toast('请先填字段名', 'err'); return; }
    addField(secId, k, $('#afValue').value);
    closeModal();
  };
  $('#mClose').onclick = closeModal;
  setTimeout(() => $('#afSearch').focus(), 50);
}

/* ---- 模板弹窗 ---- */
function openTplModal() {
  openModal('选择一个骨架开始', TEMPLATES.map((t, i) =>
    '<div class="tpl-card" data-tpl="' + i + '"><h4>' + esc(t.name) + '</h4><p>' + esc(t.desc) + '</p>' +
    '<div class="tpl-keys">' + t.keys.map(k => '<span class="tk">' + esc(k) + '</span>').join('') + '</div></div>').join(''));
  $('#modalBody').onclick = ev => {
    const c = ev.target.closest('[data-tpl]'); if (!c) return;
    const t = TEMPLATES[parseInt(c.dataset.tpl, 10)];
    const secs = t.build();
    if (S.doc.sections.length && !confirm('当前编辑区内容会被替换，继续吗？')) return;
    S.doc.sections = secs; S.doc.path = null; S.doc.name = '新单位.ini'; markDirty();
    S.ui.activeSection = secs[0] ? secs[0].id : null;
    closeModal(); renderAll();
    toast('已载入骨架：<b>' + esc(t.name) + '</b>　记得改 name / image / 数值', 'ok', 3600);
  };
}

/* ---- 打开文件弹窗 ---- */
async function openOpenModal(startPath) {
  const html =
    '<div class="form-row"><label>目录</label><input id="brPath" value="' + esc(startPath || S.modRoot || '') + '">' +
    '<button class="btn" id="brGo">转到</button></div>' +
    '<div class="form-row"><label>搜索内容</label><input id="brSearch" placeholder="在模组里搜关键字（如 copyFrom、单位名），找 ini 用">' +
    '<button class="btn" id="brSearchBtn">搜索</button></div>' +
    '<div class="crumb" id="brCrumb"></div><div class="browse-list" id="brList"></div>';
  openModal('打开模组里的文件', html, '<button class="btn" id="mClose">关闭</button>');
  let brSeq = 0;   // 迟到的响应不能覆盖后一次浏览的结果
  const load = async p => {
    const seq = ++brSeq;
    $('#brList').innerHTML = '<div class="no-result">读取中…</div>';
    try {
      const r = await fetch('/api/browse?path=' + encodeURIComponent(p));
      const d = await r.json();
      if (seq !== brSeq) return;
      if (d.error) { $('#brList').innerHTML = '<div class="no-result">' + esc(d.error) + '</div>'; return; }
      S.modRoot = d.path;
      fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modRoot: d.path }) }).catch(() => {});
      $('#brPath').value = d.path;
      $('#brCrumb').textContent = d.path;
      let h = '';
      if (d.parent && d.parent !== d.path) h += '<div class="brow" data-dir="' + esc(d.parent) + '"><span class="bi">↩</span>上级目录</div>';
      h += d.dirs.map(x => '<div class="brow" data-dir="' + esc(x.path) + '"><span class="bi">📁</span>' + esc(x.name) + '</div>').join('');
      h += d.files.map(x => '<div class="brow" data-file="' + esc(x.path) + '"><span class="bi">📄</span>' + esc(x.name) +
        '<span class="bsize">' + (x.size / 1024).toFixed(1) + ' KB</span></div>').join('');
      $('#brList').innerHTML = h || '<div class="no-result">这个目录里没有 ini / template 文件</div>';
    } catch (e) { $('#brList').innerHTML = '<div class="no-result">读取失败：' + esc(e.message) + '</div>'; }
  };
  load($('#brPath').value);
  $('#brGo').onclick = () => load($('#brPath').value);
  $('#brPath').onkeydown = e => { if (e.key === 'Enter') load($('#brPath').value); };
  $('#brList').onclick = async ev => {
    const dir = ev.target.closest('[data-dir]'), file = ev.target.closest('[data-file]');
    if (dir) return load(dir.dataset.dir);
    if (file) {
      const r = await fetch('/api/file/load?path=' + encodeURIComponent(file.dataset.file));
      const d = await r.json();
      if (d.error || d.text == null) { toast(d.error || '读不到文件内容', 'err'); return; }
      S.doc.sections = parseIni(d.text);
      S.doc.path = d.path; S.doc.name = d.name; markDirty(false);
      S.ui.activeSection = S.doc.sections[0] ? S.doc.sections[0].id : null;
      closeModal(); renderAll(); switchTab('effect');
      toast('已打开 <b>' + esc(d.name) + '</b>，共 ' + S.doc.sections.length + ' 段', 'ok');
    }
  };
  $('#brSearchBtn').onclick = async () => {
    const q = $('#brSearch').value.trim(); if (!q) return;
    $('#brList').innerHTML = '<div class="no-result">搜索中…（模组较大时需要几秒）</div>';
    const r = await fetch('/api/search?q=' + encodeURIComponent(q) + '&root=' + encodeURIComponent($('#brPath').value));
    const d = await r.json();
    $('#brList').innerHTML = d.hits.length ? d.hits.map(h =>
      '<div class="brow" data-file="' + esc(h.path) + '"><span class="bi">📄</span>' + esc(h.name) +
      '<span class="bsize">' + esc(h.dir) + '</span></div>').join('')
      : '<div class="no-result">没有文件包含「' + esc(q) + '」</div>';
  };
  $('#mClose').onclick = closeModal;
}

/* ---- 导入 / 导出 ---- */
function openImportModal() {
  openModal('粘贴 ini 代码导入', '<textarea class="paste mono" id="impText" placeholder="[core]&#10;name: 我的单位&#10;price: 100&#10;…"></textarea>',
    '<button class="btn primary" id="impOk">导入</button><button class="btn" id="mClose">取消</button>');
  $('#impOk').onclick = () => {
    const t = $('#impText').value;
    if (!t.trim()) { toast('内容为空', 'err'); return; }
    S.doc.sections = parseIni(t); markDirty();
    S.ui.activeSection = S.doc.sections[0] ? S.doc.sections[0].id : null;
    closeModal(); renderAll(); toast('导入成功，共 ' + S.doc.sections.length + ' 段', 'ok');
  };
  $('#mClose').onclick = closeModal;
}
function openExportModal() {
  const text = serialize(S.doc, { blank: $('#optBlank').checked, comment: $('#optComment').checked });
  openModal('导出代码', '<div style="display:flex;gap:8px;margin-bottom:8px">' +
    '<button class="btn" id="expCopy">复制到剪贴板</button>' +
    '<button class="btn" id="expDl">下载为 ' + esc(S.doc.name) + '</button>' +
    '<button class="btn" id="expSave">保存到文件…</button></div>' +
    '<textarea class="paste mono" id="expText" style="min-height:340px">' + esc(text) + '</textarea>',
    '<button class="btn" id="mClose">关闭</button>');
  $('#expCopy').onclick = () => { navigator.clipboard.writeText($('#expText').value).then(() => toast('已复制到剪贴板', 'ok'), () => toast('复制失败，请手动选中', 'err')); };
  $('#expDl').onclick = () => downloadText(S.doc.name, $('#expText').value);
  $('#expSave').onclick = () => saveAs($('#expText').value);
  $('#mClose').onclick = closeModal;
}
function downloadText(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/* ---- 帮助弹窗 ---- */
async function openHelpModal() {
  let netHtml = '';
  try {
    const n = await (await fetch('/api/net')).json();
    if (n.lan && n.urls && n.urls.length) {
      netHtml = '<h3>手机 / 平板访问</h3>局域网模式已开启，同一个 WiFi 下用手机浏览器打开：<br>' +
        n.urls.map(u => '<code>' + esc(u) + '</code>').join('<br>') +
        '<br>在手机浏览器里用「添加到主屏幕」，就能像 App 一样从桌面图标打开。<br>';
    } else {
      netHtml = '<h3>手机 / 平板访问</h3>现在只有本机能访问。想让手机也能用：' +
        '关掉窗口后双击 <b>启动-局域网.bat</b>（或运行 <code>python server.py --lan</code>），' +
        '再打开这个页面就会显示手机要输入的地址。<br>';
    }
  } catch (e) { /* 忽略 */ }
  openModal('使用说明', `
  <div class="ref-desc">
  <h3>1. 三个区域</h3>
  <b>左边</b>是代码表（诺瓦御科 v1.15 全量收录）：搜索框支持代码名、中文名、说明文字；点一下就把这条代码加到中间。<br>
  <b>中间</b>是图形化编辑区：每个 <code>[段]</code> 是一张卡片，字段按类型给你开关 / 滑块 / 下拉 / 调色板，右侧 <b>?</b> 是代码表里的原始说明和例子。<br>
  图形化修改（包括改段名）会实时同步右侧「代码预览」；开关类 bool 统一写 <code>true/false</code>，旧文件里的 on/off 会自动规范。<br>
  <b>最右侧</b>是实时预览侧栏：代码长什么样、单位长什么样、有没有写错。<br>
  <b>面板之间的竖条</b>可以拖动改宽，双击复位；顶栏「侧栏」按钮或右侧小圆钮可以收起，收起后变成一条图标栏，点图标直接展开对应页签。宽度与开合状态会自动记住。
  顶部常用操作只保留新建 / 模板 / 打开 / 保存 / 动画 / 体检；另存为、导入、导出、使用说明在「更多」里。<br>
  编辑区上方的「跳到段」可以快速跳段，旁边能筛选当前文件的字段（按 <code>/</code> 聚焦，Esc 清空）；手机右下角有未保存时的快捷保存按钮。<br>
  <h3>2. 怎么开始</h3>
  点顶部 <b>模板</b> 选一个骨架（基础单位 / 战斗单位 / 建筑 / 建造者 / 运输 / 采集 / 特效），再照着代码表改数值；<br>
  或者点 <b>打开</b> 直接载入模组里的现成 ini 来改（推荐，改完再保存回去）。
  <h3>3. 预览</h3>
  <b>代码预览</b>：就是最终 ini 文本，行号 + 语法高亮，写错的行会标红，可以复制 / 下载。<br>
  <b>效果预览</b>：单位卡片（血量 / 护盾 / 造价条）、按 1 格 = 20 像素画出的比例图（本体、占地、攻击圈、视野圈、炮塔位置），以及每个炮塔的伤害 / 间隔 / 每秒伤害估算。
  所有贴图和画布都按像素最近邻绘制，不做抗锯齿。<br>
  <b>错误检查</b>：点条目可直接跳到出问题的字段上。
  <h3>4. 检查会指出什么问题</h3>
  缺少 name / maxHp / radius 等必需代码；同段重复键；键放错段；未知代码；类型不对（布尔、数字、时间、颜色、逗号）；<br>
  炮塔引用不存在的抛射体；有攻击却没炮塔；打不了任何目标；溅射没半径；建筑 footprint 写反；建造者没有 canBuild 段 …… 共 69 条规则。
  <h3>5. 背包（可复用模块）</h3>
  字段右侧的 <b>☆</b> 勾选要复用的键，段头的 <b>❐</b> 把整段存成模块，然后在「背包」页签里命名保存；<br>
  换到别的单位文件后，点 <b>＋ 追加到当前文件</b> 就能直接写进去，不用再复制粘贴（整段重名会自动加序号）。
  <h3>6. 缺失引用补全</h3>
  「背包」页签下半部分会列出代码里引用了、但本文件/模组里找不到的 特效 / 动作 / 单位 / 全局变量 / 素材：<br>
  可以从背包补全、建一个空段、或"建段并存入背包"（下次别的单位也能直接复用）。勾上「扫描整个模组」会判断是否在别的文件里已存在。
  <h3>7. 模组体检</h3>
  顶部 <b>体检</b>：<br>
  · <b>素材引用</b>：哪些图片/音效从来没被任何 ini 引用（按体积排序），哪些引用了却找不到文件；<br>
  · <b>全局变量</b>：模组里所有全局资源/变量清单（含显示名、颜色、来源文件），以及"被用了但从没定义"的；<br>
  · <b>all-units 模板</b>：模组全局模板里到底有什么 —— 对全体单位生效的默认键、全局资源、模板段一览；<br>
  · <b>重复键</b>：扫全模组 <b>.ini / .template</b> 同一段内的重复键，列出文件、段名、行号和每个值；文件管理器勾「只看重复键」可切换成全模组清单，文件与所在文件夹会带红色 ⚠ 标记。
  <h3>8. 资源管理器（左侧「资源」）</h3>
  像文件管理器一样浏览模组目录：文件夹点进去、<b>双击</b>打开；<br>
  · 顶部<b>面包屑</b>可直接点任意一层跳转；可按名称 / 修改时间 / 体积 / 类型排序，列表 ↔ 缩略图视图切换（会记住）；<br>
  · 点「选择」进入多选，或 Ctrl/Shift + Click 临时多选；可<b>批量复制路径</b>或<b>批量移到回收站</b>；<br>
  · 列表聚焦后：↑/↓ 选择、Enter 打开、Delete 软删除、F2 重命名、Esc 退出多选；<br>
  · 图片直接显示缩略图，点 👁 看大图 / 音频可以试听；缩略图滚动到附近才加载，大目录切到「全部」不会一次请求几百张图；<br>
  · 结合模组体检结果，未被任何 ini 引用的素材会亮黄点，勾「只看未引用素材」就能把它们挑出来；勾「只看重复键」则列出全模组含重复键的文件，文件和文件夹都有红色 ⚠；<br>
  · 每行悬停有快捷按钮：✎ 在编辑器里打开、👁 预览、📂 在 Windows 资源管理器里定位、✏ 重命名、🗑 删除；缩略图视图收进 ⋯ 菜单；<br>
  · 右键有完整菜单（含用系统程序打开、复制路径、设为模组根）；<br>
  · 顶部按钮：↑ 上一级、🏠 模组根、⟳ 刷新、📂 在系统里打开、🔎 在模组里搜索内容；<br>
  · <b>＋ 新单位</b> 可以直接在当前目录按模板建一个新的单位 ini 并打开，<b>＋ 文件夹</b> 建目录；<br>
  · 删除是<b>软删除</b>：移到模组根下的 <code>_回收站_时间戳</code> 文件夹，随时能翻回来。
  <h3>9. 重复内容清理（当前文件）</h3>
  「错误检查」页顶部统计三类重复：点 chip 展开<b>明细列表</b>，每条都能<b>单独删除</b>或 ◎ 定位；<br>
  · <b>值完全相同的键</b>（同一段里写了两次一模一样的，删掉没影响）；<br>
  · <b>值不同的重复键</b>（游戏只读最后一条，清掉被覆盖的那些）；<br>
  · <b>重复的段</b>（同名段只保留一处，后面的字段并进来、后出现的值优先）。<br>
  也有「一键全部清理」一次搞定（带确认）。<br>
  编辑器里点过的段会亮起来标记「当前段·新字段加这里」，从左侧点代码就加到它里面。
  <h3>10. 动画制作器（缓动 / 时间轴 / 帧动画）</h3>
  顶部 <b>动画</b> 打开。RW 的动画就是 <code>[animation_名字]</code> 段里的关键帧
  （<code>arm1_2s: {x:0,y:33,dir:0}</code>、<code>body_1s: {frame:3,scale:1.5}</code>、
  <code>effect_0.3s: {..., name: 爆炸2}</code>）。<br>
  · <b>关键帧列表</b>：条目多时列表可滚动；上方「＋ 添加」展开编辑表单，底部「关键帧编辑」可收起，让列表一次显示更多条目；
   更新已有帧只覆盖表单显示字段，未显示属性保留；胳膊也支持 y 轴；选中帧后改 x/y/dir/alpha 立即生效，无需先点“更新”；<br>
  · <b>2D 舞台</b>：暂停后可直接点选画布里的补件/炮塔/腿，拖橙色 X 轴只改 x、绿色 Y 轴只改 y、中心手柄同时改 xy；
   自动在当前播放头生成或更新关键帧；拖动时按住 Ctrl 按网格吸附（默认 5，可改）；胳膊/腿有紫色 ↻ 旋转手柄，
   旋转即时写入 dir，Ctrl 时按网格角度吸附；画布滚轮缩放、中键平移，底部有 −/百分比/＋ 和重置视图；<br>
  · <b>撤销 / 重做</b>：Ctrl+Z 撤销，Ctrl+Y（或 Ctrl+Shift+Z）重做；覆盖关键帧增删/移动、补件拖动、属性修改、缓动、参数和导入载入；<br>
  · <b>项目 / 作品</b>：顶部项目栏可导入/导出 <code>animation.json</code> 项目（保留缓动源），
   也可导入/导出游戏作品 ini；作品可打包 zip 到程序根目录 <code>output</code> 或自定义路径，作品包不含 animation.json；<br>
  · <b>选定部位贴图</b>：在「部位」下拉（或点时间轴左侧部位名）选择主体 / 炮塔 / 腿脚 / 特效后，画布左上角显示该部位贴图；
   预览里用黄色虚线框高亮该部位，没有关键帧时也会静态显示，方便对齐贴图和位置；<br>
  · <b>性能</b>：制作器打开时会暂停背后的动画卡片，暗色遮罩不再做全屏模糊；播放画布不限帧率、跟随屏幕刷新率；
   播放 / 拖时间轴时画布自动降到 1x（暂停恢复高清），拖时间轴只移动当前点、不重建整条时间轴；
   播放时播放头用 CSS 合成动画跟随刷新率；暂停/拖动时用 Canvas 绘制，均不触发整条时间轴重排；
   同一贴图只解析一次、最多 4 并发，贴图回调合并重绘，arm 多的单位不会每帧重复请求；<br>
  · <b>非线性缓动</b>：每帧可选线性 / 缓入 / 缓出 / 缓入缓出 / 柔和 / 回弹 / 弹跳 / 自定义 cubic-bezier，旁边实时显示曲线；
  缓动优先段首帧，段首线性时取段尾帧；<br>
  · <b>时间轴</b>：按部件分轨，拖关键帧改时间、拖播放头/点刻度定位、Ctrl+滚轮或 ＋/− 缩放、适应、吸附 0.05s；
  选中帧后 Delete 删除，空格播放/暂停，←/→ 微调；<br>
  · <b>帧动画</b>：右侧「帧动画」页把主体贴图切成缩略图帧条，点帧插入单帧；也可填 <code>0-9</code> 序列、帧率、开始时间、往返，
  一键生成主体 frame 关键帧；<br>
  · <b>烘焙缓动</b>：RW 本体只支持线性关键帧，底部勾选后写入/复制时自动把缓动烘焙成中间帧；关闭则写入稀疏关键帧（游戏内线性）。
  底部「步长」控制采样间隔（默认 0.05 秒），按固定步长从段首采到段尾；缓动源只存浏览器 localStorage，
  不写 ini、不产生额外文件，重新打开同名动画自动恢复（ini 被外部改过则不恢复）；<br>
  · 还能<b>载入</b>：当前文件的动画段、背包里的动画模块、或搜索整个模组里现成的动画；<br>
  · 做完点「写入代码」，编辑器里就出现这个 <code>[animation_xxx]</code> 段，也能存进背包复用。
  <h3>11. 贴图与特效预览</h3>
  「效果预览」里现在能看到真东西：<br>
  · 比例图里画的是<b>拼装后的整机</b>，严格按 <b>drawOverBody</b> 分层（炮塔默认画在主体之上，
  填 false 画在主体之下；腿/胳膊默认在主体之下、true 才在之上），画布工具条可单独开关「炮塔」；<br>
  原规则：主体 + 炮塔（按 x/y 与贴图条帧号）+ 腿脚/胳膊（attach 点 + 旋转）+
  贴花（按 layer 分层）+ 附属子单位（跨文件按单位名找贴图）；<br>
  · 射程是全图时自动进入<b>「整机特写」</b>（放大到机体），取消勾选可看范围圈全景；<br>
  · 画布支持<b>滚轮缩放</b>（以光标为中心）、<b>拖动平移</b>、双击复位，工具条上也有 ＋/−/⟳ 按钮；<br>
  · 单位卡片顶部有贴图缩略图，比例图里<b>按原始像素画出本体贴图</b>（和游戏一致），多帧会动，画布下方可开关「贴图」；<br>
  · 画布工具条的 <b>「正常 / 死亡」</b> 可切换贴图状态：正常用 <code>image</code>，死亡用 <code>image_wreak</code>
   （RW 官方拼写，同时兼容 image_wreck / image_dead）。死亡状态只画整张残骸图，炮塔开关会自动禁用；
   没写 image_wreak 时会退回正常贴图并在画布和说明里提示；<br>
  · 下方「贴图 / 特效预览」把每个 <b>[effect_*]</b> 做成卡片：<b>按代码填的 frame_width/frame_height/total_frames
  分割贴图</b>，按 life 铺满 animateFrameStart→End 的关键帧（支持 PingPong），
  底部关键帧条高亮当前帧；点卡片放大看；<br>
  · 贴图引用（同目录文件名、ROOT:/路径、SHADOW:x.png）会自动找到文件；找不到会写明，
  用内置贴图条（stripIndex）的会标注"无法预览"。
  <h3>12. 全局变量与特殊字段</h3>
  打开单位文件后会自动后台扫描它所属的模组，所以 <b>addResources / price</b> 这类字段旁边会直接
  列出可用的全局变量（并带下拉补全），不用手工去 all-units 里抄。<br>
  代码表里登记为「special value」的字段（canBuild_#_name、action_#_[actionKey]、
  animation_TYPE_[animationKey]）按字符串处理，不会再误报成数字。
  <h3>13. 快捷键</h3>
  Ctrl+S 保存　Ctrl+O 打开　Ctrl+N 新建　Ctrl+K 聚焦搜索　Ctrl+B 背包　Ctrl+E 资源管理器<br>
  资源列表：↑/↓ 选择、Enter 打开、Delete 软删除、F2 重命名；动画时间轴：Space 播放/暂停、←/→ 微调、Delete 删除关键帧。
  ${netHtml}
  </div>`, '<button class="btn" id="mClose">明白了</button>');
  $('#mClose').onclick = closeModal;
}

/* ============================================================
   13. 保存 / 新建
   ============================================================ */
async function saveDoc() {
  const text = serialize(S.doc, { blank: $('#optBlank').checked, comment: $('#optComment').checked });
  if (!S.doc.path) return saveAs(text);
  const r = await fetch('/api/file/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: S.doc.path, text })
  });
  const d = await r.json();
  if (d.error) { toast('保存失败：' + esc(d.error), 'err', 4200); return; }
  markDirty(false);
  $('#fileName').textContent = S.doc.name;
  toast('已保存到 <b>' + esc(S.doc.path) + '</b>', 'ok', 3600);
}
function saveAs(preText) {
  const text = preText != null ? preText : serialize(S.doc, { blank: true, comment: $('#optComment').checked });
  const cur = S.doc.path ? S.doc.path.replace(/[\\/][^\\/]*$/, '') : (S.modRoot || '');
  openModal('另存为（填完整路径）',
    '<div class="form-row"><label>保存到</label><input id="saPath" value="' + esc(cur ? cur + '\\' + S.doc.name : S.doc.name) + '"></div>' +
    '<div class="form-row"><label></label><span class="tip">例：D:\\RTmod\\我的模组\\我的单位\\我的单位.ini　（目录不存在会自动创建）</span></div>',
    '<button class="btn primary" id="saOk">保存</button><button class="btn" id="mClose">取消</button>');
  $('#saOk').onclick = async () => {
    const p = $('#saPath').value.trim();
    if (!p) return;
    const r = await fetch('/api/file/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, text })
    });
    const d = await r.json();
    if (d.error) { toast('保存失败：' + esc(d.error), 'err', 4200); return; }
    S.doc.path = d.path; S.doc.name = d.path.replace(/^.*[\\/]/, ''); markDirty(false);
    closeModal(); renderAll(); toast('已保存到 <b>' + esc(d.path) + '</b>', 'ok', 3800);
  };
  $('#mClose').onclick = closeModal;
}
function newDoc() {
  if (S.doc.dirty && !confirm('当前有未保存的修改，确定新建吗？')) return;
  S.doc.sections = [newSection('core'), newSection('graphics'), newSection('movement'), newSection('attack')];
  S.doc.path = null; S.doc.name = '新单位.ini'; S.ui.activeSection = S.doc.sections[0].id;
  markDirty(); renderAll(); toast('已新建空单位', 'ok');
}

/* ============================================================
   20. 重复键检测 / 一键清理
   ============================================================ */

/** 统计当前文档里的重复情况 */
function dupPlan() {
  const plan = { ident: [], keepLast: [], dupSections: [], identCount: 0, keepLastCount: 0, dupSecCount: 0 };
  const seenSec = {};
  for (let i = 0; i < S.doc.sections.length; i++) {
    const sec = S.doc.sections[i];
    const byKey = {};
    for (const e of sec.entries) {
      if (e.kind !== 'field' || !e.key) continue;
      (byKey[e.key] = byKey[e.key] || []).push(e);
    }
    for (const k in byKey) {
      const list = byKey[k];
      if (list.length < 2) continue;
      const vals = list.map(x => String(x.value));
      const allSame = vals.every(v => v === vals[0]);
      if (allSame) {
        plan.ident.push({ sec: sec, key: k, keep: list[0], drop: list.slice(1) });
        plan.identCount += list.length - 1;
      } else {
        plan.keepLast.push({ sec: sec, key: k, keep: list[list.length - 1], drop: list.slice(0, -1) });
        plan.keepLastCount += list.length - 1;
      }
    }
    if (seenSec[sec.name] === undefined) seenSec[sec.name] = i;
    else {
      plan.dupSections.push({ first: S.doc.sections[seenSec[sec.name]], later: sec });
      plan.dupSecCount++;
    }
  }
  return plan;
}

/** 一键清理 */
function cleanDuplicates(mode, sel) {
  const plan = dupPlan();
  let removed = 0;
  if (mode === 'one') {
    // 只处理用户点的那一条：ident:2 / keepLast:0 / dupSec:1
    const kind = (sel || '').split(':')[0];
    const idx = parseInt((sel || '').split(':')[1], 10);
    if (kind === 'ident') {
      const it = plan.ident[idx];
      if (!it) return;
      const drop = new Set(it.drop.map(x => x.id));
      it.sec.entries = it.sec.entries.filter(e => !drop.has(e.id));
      removed = drop.size;
      toast('已删掉 <b>' + removed + '</b> 条重复的 ' + esc(it.key) + '（保留第一条）', 'ok', 3000);
    } else if (kind === 'keepLast') {
      const it = plan.keepLast[idx];
      if (!it) return;
      const drop = new Set(it.drop.map(x => x.id));
      it.sec.entries = it.sec.entries.filter(e => !drop.has(e.id));
      removed = drop.size;
      toast('已删掉 <b>' + removed + '</b> 条被覆盖的 ' + esc(it.key) + '（保留最后一条，和游戏行为一致）', 'ok', 3200);
    } else if (kind === 'dupSec') {
      const it = plan.dupSections[idx];
      if (!it) return;
      const first = it.first, later = it.later;
      for (const e of later.entries) {
        if (e.kind !== 'field' || !e.key) { first.entries.push(e); removed++; continue; }
        first.entries = first.entries.filter(x => x.key !== e.key);
        first.entries.push(e);
        removed++;
      }
      later.entries = [];
      S.doc.sections = S.doc.sections.filter(x => x.entries.length > 0);
      toast('已合并重复段 <b>[' + esc(later.name) + ']</b>（后面的值优先）', 'ok', 3200);
    }
    markDirty(); renderAll();
    return;
  }
  if (mode === 'ident') {
    if (!plan.identCount) { toast('没有值完全相同的重复键，不用清理', '', 2600); return; }
    for (const it of plan.ident) {
      const drop = new Set(it.drop.map(x => x.id));
      it.sec.entries = it.sec.entries.filter(e => !drop.has(e.id));
      removed += drop.size;
    }
    markDirty(); renderAll();
    toast('已删掉 <b>' + removed + '</b> 个值完全相同的重复键（保留每个键的第一条，效果没有任何变化）', 'ok', 4200);
  } else if (mode === 'keepLast') {
    if (!plan.keepLastCount) { toast('没有值不同的重复键，不用清理', '', 2600); return; }
    for (const it of plan.keepLast) {
      const drop = new Set(it.drop.map(x => x.id));
      it.sec.entries = it.sec.entries.filter(e => !drop.has(e.id));
      removed += drop.size;
    }
    markDirty(); renderAll();
    toast('已删掉 <b>' + removed + '</b> 条被后面覆盖的重复键（游戏本来也只读最后一条，结果一样）', 'ok', 4600);
  } else if (mode === 'mergeSec') {
    if (!plan.dupSecCount) { toast('没有重复的段名', '', 2600); return; }
    let moved = 0;
    for (const it of plan.dupSections) {
      const first = it.first, later = it.later;
      for (const e of later.entries) {
        if (e.kind !== 'field' || !e.key) { first.entries.push(e); moved++; continue; }
        // 同名键：把前面所有同名条目都去掉再追加，保证「后出现的说了算」，
        // 否则只改第一条的话，段里排在后面的旧值仍然会生效（RW 读最后一条）
        first.entries = first.entries.filter(x => x.key !== e.key);
        first.entries.push(e);
        moved++;
      }
      later.entries = [];
    }
    S.doc.sections = S.doc.sections.filter(s => s.entries.length > 0);
    markDirty(); renderAll();
    toast('已把 <b>' + plan.dupSecCount + '</b> 个重复段合并进第一次出现的那段（共搬 ' + moved + ' 个字段，后面的值优先）', 'ok', 5200);
  }
}

/** 检查面板顶部的清理按钮 */
/* 重复明细的展开状态（按类型记忆） */
function dupOpen(kind) {
  if (S.ui.dupOpen === undefined) S.ui.dupOpen = { ident: true, keepLast: true, dupSec: true };
  return !!S.ui.dupOpen[kind];
}
function renderDupBar() {
  const bar = $('#dupBar');
  if (!bar) return;
  const p = dupPlan();
  S.ui.dup = p;
  const total = p.identCount + p.keepLastCount + p.dupSecCount;
  const chip = (kind, icon, label, n, cls, cleanId, cleanHint) =>
    '<div class="dup-chip ' + cls + (n ? '' : ' zero') + (dupOpen(kind) && n ? ' open' : '') + '" data-dupkind="' + kind + '">' +
    '<span class="dc-ico">' + icon + '</span>' +
    '<span class="dc-txt">' + label + '</span>' +
    '<span class="dc-n">' + n + '</span>' +
    (n ? '<button class="icon-btn dc-clean" data-dup="' + cleanId + '" title="' + esc(cleanHint) + '">🧹</button>' : '') +
    '</div>';
  bar.innerHTML =
    (total
      ? '<span class="dup-tip">🧹 重复内容：</span>' +
        chip('ident', '🟡', '值完全相同的键', p.identCount, 'warn',
             'ident', '一键删掉所有值完全相同的重复键（无任何影响）') +
        chip('keepLast', '🔴', '值不同的重复键', p.keepLastCount, 'bad',
             'keepLast', '一键只保留每组最后一条（与游戏行为一致）') +
        chip('dupSec', '🟣', '重复的段', p.dupSecCount, 'sec',
             'mergeSec', '一键合并所有重复段（后面的值优先）') +
        (total > 1 ? '<button class="btn small primary" data-dup="__all">一键全部清理</button>' : '')
      : '<span class="dup-tip ok">✓ 没有重复键、也没有重复段</span>');
  bar.onclick = ev => {
    const clean = ev.target.closest('[data-dup]');
    if (clean) {
      if (clean.dataset.dup === '__all') cleanAllDuplicates();
      else cleanDuplicates(clean.dataset.dup);
      return;
    }
    const chipEl = ev.target.closest('[data-dupkind]');
    if (chipEl) {
      const kind = chipEl.dataset.dupkind;
      S.ui.dupOpen[kind] = !dupOpen(kind);
      renderDupBar(); renderDupDetails();
    }
  };
}

/* 一键全部清理（按安全顺序：相同值 → 被覆盖值 → 合并段） */
function cleanAllDuplicates() {
  const p = dupPlan();
  if (!p.identCount && !p.keepLastCount && !p.dupSecCount) return;
  if (!confirm('一键清理全部重复内容？\n\n' +
    '· 值完全相同的键 ' + p.identCount + ' 条（无影响）\n' +
    '· 被覆盖的重复键 ' + p.keepLastCount + ' 条（结果不变）\n' +
    '· 合并重复段 ' + p.dupSecCount + ' 个（后面的值优先）')) return;
  if (p.identCount) cleanDuplicates('ident');
  if (p.keepLastCount) cleanDuplicates('keepLast');
  if (p.dupSecCount) cleanDuplicates('mergeSec');
}

/* ---------- 重复明细列表（每条可单独删除 / 定位） ---------- */
function renderDupDetails() {
  const box = $('#dupDetails');
  if (!box) return;
  const p = S.ui.dup || dupPlan();
  const valChips = it => {
    const seen = new Set();
    const out = [];
    for (const e of it.sec.entries) {
      if (e.kind === 'field' && e.key === it.key && !seen.has(e.id)) {
        seen.add(e.id);
        const isKeep = it.keep && e.id === it.keep.id;
        out.push('<span class="dv' + (isKeep ? ' keep' : ' drop') + '">' + esc(String(e.value).slice(0, 36)) +
          (isKeep ? '<i>保留</i>' : '') + '</span>');
      }
    }
    return out.join('');
  };
  const group = (kind, icon, title, items, renderItem) => {
    if (!items.length) return '';
    const open = dupOpen(kind);
    return '<div class="dup-group">' +
      '<div class="dg-head" data-dupkind="' + kind + '">' +
      '<span class="dg-caret">' + (open ? '▼' : '▶') + '</span>' + icon + ' ' + title +
      '<span class="dg-n">' + items.length + ' 组</span>' +
      '<button class="btn small" data-dup="' + ({ ident: 'ident', keepLast: 'keepLast', dupSec: 'mergeSec' })[kind] + '">全部处理</button>' +
      '</div>' +
      (open ? '<div class="dg-body">' + items.map(renderItem).join('') + '</div>' : '') +
      '</div>';
  };
  const secLabel = sec => '[' + esc(String(sec.name).replace(/^\[|\]$/g, '')) + ']';
  let html = '';
  html += group('ident', '🟡', '值完全相同的键（删掉多余的无任何影响）', p.ident, it =>
    '<div class="dup-item warn" data-dupid="ident:' + p.ident.indexOf(it) + '">' +
    '<span class="di-sec">' + secLabel(it.sec) + '</span>' +
    '<span class="di-key">' + esc(it.key) + '</span>' +
    '<span class="di-vals">' + valChips(it) + '</span>' +
    '<span class="grow"></span>' +
    '<button class="icon-btn" data-dupgoto="' + esc(it.sec.name) + '|' + esc(it.key) + '" title="定位到字段">◎</button>' +
    '<button class="btn mini danger" data-dupone="ident:' + p.ident.indexOf(it) + '">删除多余 ×' + it.drop.length + '</button>' +
    '</div>');
  html += group('keepLast', '🔴', '值不同的重复键（游戏只读最后一条）', p.keepLast, it =>
    '<div class="dup-item bad" data-dupid="keepLast:' + p.keepLast.indexOf(it) + '">' +
    '<span class="di-sec">' + secLabel(it.sec) + '</span>' +
    '<span class="di-key">' + esc(it.key) + '</span>' +
    '<span class="di-vals">' + valChips(it) + '</span>' +
    '<span class="grow"></span>' +
    '<button class="icon-btn" data-dupgoto="' + esc(it.sec.name) + '|' + esc(it.key) + '" title="定位到字段">◎</button>' +
    '<button class="btn mini danger" data-dupone="keepLast:' + p.keepLast.indexOf(it) + '">只留最后 ×' + it.drop.length + '</button>' +
    '</div>');
  html += group('dupSec', '🟣', '重复的段（后面的覆盖前面的）', p.dupSections, it =>
    '<div class="dup-item sec" data-dupid="dupSec:' + p.dupSections.indexOf(it) + '">' +
    '<span class="di-sec">' + secLabel(it.first) + '</span>' +
    '<span class="di-key">↔</span>' +
    '<span class="di-sec">' + secLabel(it.later) + '</span>' +
    '<span class="di-vals"><span class="dv">' + it.later.entries.filter(e => e.kind === 'field').length + ' 个字段并入</span></span>' +
    '<span class="grow"></span>' +
    '<button class="icon-btn" data-dupgoto="' + esc(it.later.name) + '" title="定位到重复的段">◎</button>' +
    '<button class="btn mini danger" data-dupone="dupSec:' + p.dupSections.indexOf(it) + '">合并这一对</button>' +
    '</div>');
  box.innerHTML = html;
  box.style.display = html ? '' : 'none';
  box.onclick = ev => {
    const head = ev.target.closest('.dg-head');
    if (head) {
      const kind = head.dataset.dupkind;
      S.ui.dupOpen[kind] = !dupOpen(kind);
      renderDupBar(); renderDupDetails();
      return;
    }
    const one = ev.target.closest('[data-dupone]');
    if (one) { cleanDuplicates('one', one.dataset.dupone); return; }
    const cl = ev.target.closest('[data-dup]');
    if (cl) { cleanDuplicates(cl.dataset.dup); return; }
    const go = ev.target.closest('[data-dupgoto]');
    if (go) {
      const nm = go.dataset.dupgoto.split('|')[0];
      const key = go.dataset.dupgoto.split('|')[1];
      const sec = S.doc.sections.find(x => x.name === nm);
      if (sec) {
        sec.collapsed = false; renderEditor(); switchTab('code');
        if (key) focusField(deriveSecId(nm), key);
      }
    }
  };
}

/* ============================================================
   18. 资源管理器（左侧「资源」页）
   ============================================================ */
const FS_ICON = { dir: '📁', ini: '📄', image: '🖼', audio: '🎵', text: '📝', pack: '📦', other: '📄' };
const TINY_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
let _fsThumbIO = null;
/** 缩略图只在滚到附近时才加载，避免“显示全部”时一次请求几百张图把界面拖死 */
function fsLazyThumbs(box) {
  if (!box) return;
  const imgs = Array.from(box.querySelectorAll('img[data-src]'));
  if (!imgs.length) return;
  if (_fsThumbIO) { try { _fsThumbIO.disconnect(); } catch (e) { /* 忽略 */ } _fsThumbIO = null; }
  const load = img => {
    const src = img.dataset.src;
    if (!src) return;
    img.src = src;
    img.removeAttribute('data-src');
  };
  if (!('IntersectionObserver' in window)) { imgs.forEach(load); return; }
  _fsThumbIO = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      load(en.target);
      if (_fsThumbIO) _fsThumbIO.unobserve(en.target);
    }
  }, { root: box, rootMargin: '160px 0px' });
  imgs.forEach(img => _fsThumbIO.observe(img));
}

function humanTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000), now = new Date();
  const p = n => (n < 10 ? '0' : '') + n;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return p(d.getHours()) + ':' + p(d.getMinutes());
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ---------- 文件管理器：目录缓存 + 断网重试 ---------- */
const FS_DIR_CACHE = new Map();
const FS_CACHE_MAX = 80;
function fsNormPath(p) { return String(p || '').replace(/[\\/]+$/, '').toLowerCase(); }
function fsCacheCurrent() {
  if (!S.fs || !S.fs.path) return;
  const key = fsNormPath(S.fs.path);
  if (!key) return;
  FS_DIR_CACHE.delete(key);
  FS_DIR_CACHE.set(key, {
    path: S.fs.path, parent: S.fs.parent, name: S.fs.name,
    dirs: S.fs.dirs || [], files: S.fs.files || [],
    modRoot: S.fs.modRoot || '', defaultRoot: S.fs.defaultRoot || '',
  });
  while (FS_DIR_CACHE.size > FS_CACHE_MAX) FS_DIR_CACHE.delete(FS_DIR_CACHE.keys().next().value);
}
function fsCacheSet(d) {
  if (!d || !d.path) return;
  const key = fsNormPath(d.path);
  FS_DIR_CACHE.delete(key);
  FS_DIR_CACHE.set(key, d);
  while (FS_DIR_CACHE.size > FS_CACHE_MAX) FS_DIR_CACHE.delete(FS_DIR_CACHE.keys().next().value);
}
function fsApplyData(d, keepFilter) {
  S.fs = {
    path: d.path, parent: d.parent, name: d.name, dirs: d.dirs || [], files: d.files || [],
    modRoot: d.modRoot || '', defaultRoot: d.defaultRoot || '',
    sel: keepFilter ? S.fs.sel : null,
  };
  S.modRoot = S.modRoot || d.path;
  if ($('#fsPath')) $('#fsPath').value = d.path;
}
async function fsFetchList(path, kinds) {
  const url = '/api/fs/list?path=' + encodeURIComponent(path) +
    '&kinds=' + encodeURIComponent(kinds) + '&_=' + Date.now();
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      let data = null;
      try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
      if (data && typeof data === 'object') return data;
      if (!res.ok) return { error: '读取目录失败（HTTP ' + res.status + '）' };
      throw new Error('服务器返回空响应');
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('Failed to fetch');
}

async function fsGo(path, keepFilter) {
  if (!path) path = S.fs.path || S.modRoot || '';
  const seq = (S.ui._fsSeq || 0) + 1;
  S.ui._fsSeq = seq;
  const cached = FS_DIR_CACHE.get(fsNormPath(path));
  if (path !== S.fs.path) {
    fsCacheCurrent();
    fsClearSel();
  }
  if (cached) {
    // 先显示已缓存的目录，网络回来后再无闪烁地刷新
    fsApplyData(cached, keepFilter);
    S.ui.fsLoading = false;
    renderFs();
  } else {
    S.ui.fsLoading = true;
    renderFs();
  }
  const kinds = $('#fsKinds') ? $('#fsKinds').value : 'ini,image,audio,text';
  let d = null, netErr = null;
  try { d = await fsFetchList(path, kinds); } catch (e) { netErr = e; }
  // 用户已经点了别的目录，丢弃这次过期响应
  if (seq !== S.ui._fsSeq) return;
  if (d && !d.error) {
    fsCacheSet(d);
    fsApplyData(d, keepFilter);
    S.ui.fsLoading = false;
    renderFs();
    return;
  }
  S.ui.fsLoading = false;
  if (d && d.error) {
    toast(esc(d.error), 'err', 3600);
    if (!cached) renderFs();
    return;
  }
  // 网络层失败：有缓存就继续用缓存，不让目录变空
  if (cached) {
    // 有缓存就不把 Failed to fetch 当致命错误弹红字，目录照常可用
    renderFs();
    toast('网络暂时中断，已显示缓存目录；可点刷新重试', '', 3000);
  } else {
    const msg = '读取目录失败：' + esc(netErr && netErr.message || 'Failed to fetch');
    toast(msg, 'err', 3600);
    renderFs();
  }
}

/* ---------- 文件管理器：排序 / 面包屑 / 多选 ---------- */
function fsSortItems(items, mode) {
  const [key, dir] = String(mode || 'name-asc').split('-');
  const sign = dir === 'desc' ? -1 : 1;
  return (items || []).slice().sort((a, b) => {
    let va, vb;
    if (key === 'size') { va = a.size || 0; vb = b.size || 0; }
    else if (key === 'mtime') { va = a.mtime || 0; vb = b.mtime || 0; }
    else if (key === 'kind') { va = String(a.kind || ''); vb = String(b.kind || ''); }
    else { va = String(a.name || '').toLowerCase(); vb = String(b.name || '').toLowerCase(); }
    if (va < vb) return -1 * sign;
    if (va > vb) return 1 * sign;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
  });
}
function fsSelected(path) { return S.ui.fsMulti && S.ui.fsMulti.has(path); }
function fsToggleSel(path, on) {
  if (!path) return;
  if (!S.ui.fsMulti) S.ui.fsMulti = new Set();
  const want = on === undefined ? !S.ui.fsMulti.has(path) : !!on;
  if (want) S.ui.fsMulti.add(path); else S.ui.fsMulti.delete(path);
  fsUpdateSelbar();
}
function fsClearSel() {
  if (S.ui.fsMulti) S.ui.fsMulti.clear();
  S.ui.fsAnchor = null;
  fsUpdateSelbar();
}
function fsUpdateSelbar() {
  const bar = $('#fsSelbar');
  if (!bar) return;
  const n = S.ui.fsMulti ? S.ui.fsMulti.size : 0;
  if (!n) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = '<span class="fsel-count">已选 <b>' + n + '</b> 项</span>' +
    '<span class="grow"></span>' +
    '<button class="btn small ghost" data-fsselcopy>复制路径</button>' +
    '<button class="btn small ghost" data-fsseltrash>移到回收站</button>' +
    '<button class="btn small ghost" data-fsselclear>取消</button>';
}
function fsCheckHtml(path) {
  return '<span class="fs-check"><input type="checkbox" data-fscheck="' + esc(path) + '"' +
    (fsSelected(path) ? ' checked' : '') + ' aria-label="选择"></span>';
}
function fsMenuHtml(path) {
  return '<button class="icon-btn fs-menu" data-fsmenu="' + esc(path) + '" title="更多操作">⋯</button>';
}
function fsPathOfRow(row) {
  return row ? (row.dataset.file || row.dataset.dir || '') : '';
}
function fsSelectRange(anchor, path) {
  const rows = $$('#fsList .fs-row').filter(r => !r.classList.contains('fs-empty'));
  const paths = rows.map(fsPathOfRow);
  const a = paths.indexOf(anchor), b = paths.indexOf(path);
  if (a < 0 || b < 0) { fsToggleSel(path, true); return; }
  const lo = Math.min(a, b), hi = Math.max(a, b);
  for (let i = lo; i <= hi; i++) if (paths[i]) S.ui.fsMulti.add(paths[i]);
  S.ui.fsAnchor = anchor;
  fsUpdateSelbar();
}
function renderFsCrumbs() {
  const box = $('#fsCrumbs');
  if (!box) return;
  const path = S.fs.path || '';
  if (!path) { box.innerHTML = ''; return; }
  const parts = path.split('\\').filter(Boolean);
  let acc = '';
  let nodes = parts.map((p, i) => {
    acc = i === 0 ? p + '\\' : acc + (acc.endsWith('\\') ? '' : '\\') + p;
    return { label: p, path: acc };
  });
  if (nodes.length > 5) nodes = [nodes[0], { label: '…', path: '' }].concat(nodes.slice(-3));
  box.innerHTML = nodes.map(n => n.path
    ? '<button class="fs-crumb" data-fsgo="' + esc(n.path) + '" title="' + esc(n.path) + '">' + esc(n.label) + '</button><span class="fs-crumb-sep">/</span>'
    : '<span class="fs-crumb-sep">…/</span>').join('');
}
function fsSyncViewButtons() {
  const l = $('#fsViewList'), g = $('#fsViewGrid'), s = $('#fsSelect');
  if (l) l.classList.toggle('active', S.ui.fsView !== 'grid');
  if (g) g.classList.toggle('active', S.ui.fsView === 'grid');
  if (s) {
    s.textContent = S.ui.fsSelect ? '完成' : '选择';
    s.classList.toggle('primary', !!S.ui.fsSelect);
  }
}
async function fsTrashMany(paths) {
  paths = (paths || []).filter(Boolean);
  if (!paths.length) return;
  if (!confirm('把选中的 ' + paths.length + ' 项移到回收站文件夹？\n\n不会真的删除：会移动到模组根目录下的 _回收站_时间戳 文件夹，随时可以找回。')) return;
  toast('正在移动 ' + paths.length + ' 项到回收站…', '', 3000);
  let ok = 0, bad = 0;
  for (const p of paths) {
    try {
      const d = await (await fetch('/api/fs/trash', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p })
      })).json();
      if (d.error) bad++; else {
        ok++;
        if (S.doc.path === p) { S.doc.path = null; markDirty(false); }
      }
    } catch (e) { bad++; }
  }
  fsClearSel();
  S.ui.fsSelect = false;
  S.scan = null;
  fsSyncViewButtons();
  await fsGo(S.fs.path, true);
  toast('已移动 ' + ok + ' 项到回收站' + (bad ? '，' + bad + ' 项失败' : ''), bad ? 'err' : 'ok', 4200);
}

/* 全模组「含重复键的 ini/template」平铺列表 */
function renderFsDupes() {
  const box = $('#fsList');
  box.classList.toggle('grid', S.ui.fsView === 'grid');
  box.classList.toggle('selecting', !!S.ui.fsSelect);
  const st0 = box.scrollTop;
  fsSyncViewButtons();
  const sc = S.scan || {};
  const q = ($('#fsFilter').value || '').trim().toLowerCase();
  const all = ((sc.duplicates && sc.duplicates.files) || []).slice();
  let items = all.filter(f => !q || (f.name + ' ' + f.rel + ' ' + (f.sections || []).join(' ')).toLowerCase().includes(q));
  items.sort((a, b) => (b.keys || 0) - (a.keys || 0) || String(a.name).localeCompare(String(b.name), 'zh'));
  const hi = (name) => {
    if (!q) return esc(name);
    const i = name.toLowerCase().indexOf(q);
    if (i < 0) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
  };
  const rows = items.map(f => {
    const full = f.path;
    const parent = esc((f.rel || '').replace(/[^\\]+$/, ''));
    return '<div class="fs-row has-dup' + (fsSelected(full) ? ' selected' : '') + '" data-file="' + esc(full) +
      '" data-kind="ini" title="' + esc(full + '\n段内重复键：' + f.groups + ' 组 / ' + f.keys + ' 处') + '">' +
      fsCheckHtml(full) +
      '<span class="fi">' + FS_ICON.ini + '</span>' +
      '<span class="fs-name">' + hi(f.name) + '</span>' +
      '<span class="fs-dup" title="段内重复键">⚠ ' + f.keys + '处</span>' +
      '<span class="fs-meta" style="max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + parent + '</span>' +
      '<span class="fs-meta">' + f.groups + ' 组</span>' +
      '<span class="fs-act">' +
      fsMenuHtml(full) +
      '<button class="icon-btn" data-fsedit="' + esc(full) + '" title="在编辑器里打开">✎</button>' +
      '<button class="icon-btn" data-fsreveal="' + esc(full) + '" title="在资源管理器里定位">📂</button>' +
      '<button class="icon-btn" data-fscopy="' + esc(full) + '" title="复制路径">⧉</button>' +
      '<button class="icon-btn danger" data-fstrash="' + esc(full) + '" title="移到回收站文件夹">🗑</button>' +
      '</span></div>';
  }).join('');
  box.innerHTML = rows || '<div class="fs-empty">没有发现段内重复键 ✓<br>' +
    (q ? '（或没有匹配「' + esc(q) + '」的）' :
      (sc.ok ? '已检查 ' + (sc.files || 0) + ' 个 ini/template' : '先跑一次模组体检')) + '</div>';
  box.scrollTop = st0;
  const dq = sc.duplicates || {};
  $('#fsFoot').innerHTML =
    '<span>全模组重复键文件：' + items.length + ' / ' + (dq.fileCount || all.length) + ' 个</span>' +
    '<span class="au-tag bad">' + (dq.groupCount || 0) + ' 组 / ' + (dq.keyCount || 0) + ' 处</span>' +
    '<span class="grow"></span>' +
    '<span title="' + esc(sc.root || '') + '">扫描目录：' + esc(((sc.root || '').split('\\').pop())) + '</span>';
  fsUpdateSelbar();
}

/* 全模组「未被引用的素材」平铺列表 */
function renderFsUnused() {
  const box = $('#fsList');
  box.classList.toggle('grid', S.ui.fsView === 'grid');
  box.classList.toggle('selecting', !!S.ui.fsSelect);
  const st0 = box.scrollTop;
  fsSyncViewButtons();
  const sc = S.scan;
  const q = ($('#fsFilter').value || '').trim().toLowerCase();
  const root = sc.root || '';
  let items = fsSortItems((sc.assets.unused || []).slice(), S.ui.fsSort);
  if (q) items = items.filter(u => (u.name + ' ' + u.rel).toLowerCase().includes(q));
  const totalBytes = items.reduce((a, u) => a + (u.size || 0), 0);
  const hi = (name) => {
    if (!q) return esc(name);
    const i = name.toLowerCase().indexOf(q);
    if (i < 0) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
  };
  const rows = items.map(u => {
    const full = u.rel ? (root.replace(/[\\/]$/, '') + '\\' + u.rel) : u.name;
    const kind = file_kind_js(u.name);
    const thumb = kind === 'image'
      ? '<img src="' + TINY_IMG + '" data-src="/api/file/raw?path=' + encodeURIComponent(full) +
        '" loading="lazy" decoding="async" fetchpriority="low" alt="">'
      : (kind === 'audio' ? '🎵' : '📄');
    return '<div class="fs-row' + (fsSelected(full) ? ' selected' : '') + '" data-file="' + esc(full) + '" data-kind="' + kind + '" title="' + esc(full) + '">' +
      fsCheckHtml(full) +
      '<span class="fi">' + thumb + '</span>' +
      '<span class="fs-name">' + hi(u.name) + '</span>' +
      '<span class="dot unused" title="没有被任何 ini 引用"></span>' +
      '<span class="fs-meta" style="max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        esc((u.rel || '').replace(/[^\\]+$/, '')) + '</span>' +
      '<span class="fs-meta">' + fmtSize(u.size || 0) + '</span>' +
      '<span class="fs-act">' +
      fsMenuHtml(full) +
      '<button class="icon-btn" data-fsview="' + esc(full) + '" title="预览">👁</button>' +
      '<button class="icon-btn" data-fsreveal="' + esc(full) + '" title="在资源管理器里定位">📂</button>' +
      '<button class="icon-btn" data-fscopy="' + esc(full) + '" title="复制路径">⧉</button>' +
      '<button class="icon-btn" data-fsrename="' + esc(full) + '" title="重命名">✏</button>' +
      '<button class="icon-btn danger" data-fstrash="' + esc(full) + '" title="移到回收站文件夹">🗑</button>' +
      '</span></div>';
  }).join('');
  box.innerHTML = rows || '<div class="fs-empty">没有被引用的素材 ✓<br>（或没有匹配「' + esc(q) + '」的）</div>';
  fsLazyThumbs(box);
  box.scrollTop = st0;
  $('#fsFoot').innerHTML =
    '<span>全模组未引用素材：' + items.length + ' / ' + (sc.assets.unusedCount || items.length) + ' 个</span>' +
    '<span class="au-tag">合计 ' + fmtSize(totalBytes) + '</span>' +
    '<span class="grow"></span>' +
    '<span title="' + esc(sc.root) + '">扫描目录：' + esc((sc.root || '').split('\\').pop()) + '</span>';
  fsUpdateSelbar();
}

function file_kind_js(name) {
  const e = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'].indexOf(e) >= 0) return 'image';
  if (['.ogg', '.wav', '.mp3', '.m4a'].indexOf(e) >= 0) return 'audio';
  if (e === '.ini' || e === '.template') return 'ini';
  return 'other';
}

/* 体检结果 → 素材引用状态，用于列表里的圆点与筛选 */
function fsAssetState(nameLower) {
  const sc = S.scan;
  if (!sc || !sc.ok || !sc.assets) return '';
  if ((sc.assets.index || []).indexOf(nameLower) >= 0) {
    return (sc.assets.unused || []).some(u => String(u.name).toLowerCase() === nameLower) ? 'unused' : 'used';
  }
  return '';
}
function fsUnusedSet() {
  const sc = S.scan;
  if (!sc || !sc.ok || !sc.assets) return null;
  return new Set((sc.assets.unused || []).map(u => String(u.name).toLowerCase()));
}
function fsDupMap() {
  const sc = S.scan;
  const map = new Map();
  if (!sc || !sc.ok || !sc.duplicates) return map;
  for (const f of (sc.duplicates.files || [])) {
    if (f.path) map.set(String(f.path).toLowerCase(), f);
  }
  return map;
}

function renderFs() {
  const box = $('#fsList');
  if (!box) return;
  box.classList.toggle('grid', S.ui.fsView === 'grid');
  box.classList.toggle('selecting', !!S.ui.fsSelect);
  renderFsCrumbs();
  fsSyncViewButtons();
  if (S.ui.fsLoading) { box.innerHTML = '<div class="fs-empty">读取中…</div>'; fsUpdateSelbar(); return; }
  // 勾了「只看未引用素材」/「只看重复键」→ 显示全模组平铺列表（不用一个目录一个目录翻）
  if ($('#fsOnlyDup') && $('#fsOnlyDup').checked && S.scan && S.scan.ok) return renderFsDupes();
  if ($('#fsOnlyUnused').checked && S.scan && S.scan.ok) return renderFsUnused();
  if (!S.fs.path) {
    box.innerHTML = '<div class="fs-empty">还没有打开目录<br>点上面的 🏠 跳到模组根，或直接改路径后回车。<br>' +
      '想先选模组目录，可以用顶部的「打开」。</div>';
    fsUpdateSelbar();
    return;
  }
  const st0 = box.scrollTop, sl0 = box.scrollLeft;
  const q = ($('#fsFilter').value || '').trim().toLowerCase();
  const onlyUnused = $('#fsOnlyUnused').checked;
  const unused = fsUnusedSet();
  const dupMap = fsDupMap();
  const dupDirCount = (p) => {
    const prefix = String(p).toLowerCase().replace(/[\\/]+$/, '') + '\\';
    let n = 0;
    for (const k of dupMap.keys()) if (k.startsWith(prefix)) n++;
    return n;
  };
  const hi = (name) => {
    if (!q) return esc(name);
    const i = name.toLowerCase().indexOf(q);
    if (i < 0) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
  };

  let rows = [];
  const dirs = fsSortItems(S.fs.dirs, S.ui.fsSort);
  const files = fsSortItems(S.fs.files, S.ui.fsSort);
  for (const d of dirs) {
    if (q && !d.name.toLowerCase().includes(q)) continue;
    if (onlyUnused) continue;
    const dc = dupDirCount(d.path);
    const dirDup = dc ? '<span class="fs-dup" title="文件夹内有 ' + dc + ' 个含重复键的文件">⚠ ' + dc + '</span>' : '';
    rows.push('<div class="fs-row isdir' + (S.fs.sel === d.path ? ' sel' : '') +
      (fsSelected(d.path) ? ' selected' : '') + (dc ? ' has-dup' : '') +
      '" data-dir="' + esc(d.path) + '" title="' + esc(d.path + (dc ? '\n含重复键文件：' + dc + ' 个' : '')) + '">' +
      fsCheckHtml(d.path) +
      '<span class="fi">' + (d.trash ? '🗑' : FS_ICON.dir) + '</span>' +
      '<span class="fs-name">' + hi(d.name) + (d.trash ? ' <span class="au-tag">回收站</span>' : '') + '</span>' + dirDup +
      '<span class="fs-meta">' + humanTime(d.mtime) + '</span>' +
      '<span class="fs-act">' +
      fsMenuHtml(d.path) +
      '<button class="icon-btn" data-fsopen="' + esc(d.path) + '" title="进入">→</button>' +
      '<button class="icon-btn" data-fsreveal="' + esc(d.path) + '" title="在 Windows 资源管理器里打开">📂</button>' +
      '</span></div>');
  }
  let shown = 0;
  for (const f of files) {
    if (q && !f.name.toLowerCase().includes(q)) continue;
    const st = (f.kind === 'image' || f.kind === 'audio') ? fsAssetState(f.name.toLowerCase()) : '';
    if (onlyUnused && st !== 'unused') continue;
    shown++;
    const thumb = f.kind === 'image'
      ? '<img src="' + TINY_IMG + '" data-src="/api/file/raw?path=' + encodeURIComponent(f.path) +
        '" loading="lazy" decoding="async" fetchpriority="low" alt="">'
      : (f.kind === 'audio' ? '🎵' : FS_ICON[f.kind] || '📄');
    const dot = st === 'unused' ? '<span class="dot unused" title="没有被任何 ini 引用"></span>'
      : (st === 'used' ? '<span class="dot used" title="已被引用"></span>' : '');
    const dup = dupMap.get(String(f.path).toLowerCase());
    const dupBadge = dup ? '<span class="fs-dup" title="段内重复键：' + dup.groups + ' 组 / ' +
      dup.keys + ' 处">⚠ ' + dup.keys + '处</span>' : '';
    const dupTitle = dup ? '\n段内重复键：' + dup.groups + ' 组 / ' + dup.keys + ' 处' : '';
    rows.push('<div class="fs-row' + (S.fs.sel === f.path ? ' sel' : '') +
      (fsSelected(f.path) ? ' selected' : '') + (dup ? ' has-dup' : '') + '" data-file="' + esc(f.path) +
      '" data-kind="' + f.kind + '" title="' + esc(f.path + dupTitle) + '">' +
      fsCheckHtml(f.path) +
      '<span class="fi">' + thumb + '</span>' +
      '<span class="fs-name">' + hi(f.name) + '</span>' + dupBadge + dot +
      '<span class="fs-meta">' + fmtSize(f.size) + '</span>' +
      '<span class="fs-meta">' + humanTime(f.mtime) + '</span>' +
      '<span class="fs-act">' +
      fsMenuHtml(f.path) +
      '<button class="icon-btn" data-fsedit="' + esc(f.path) + '" title="在编辑器里打开">✎</button>' +
      '<button class="icon-btn" data-fsview="' + esc(f.path) + '" title="预览">👁</button>' +
      '<button class="icon-btn" data-fsreveal="' + esc(f.path) + '" title="在资源管理器里定位">📂</button>' +
      '<button class="icon-btn" data-fsrename="' + esc(f.path) + '" title="重命名">✏</button>' +
      '<button class="icon-btn danger" data-fstrash="' + esc(f.path) + '" title="移到回收站文件夹">🗑</button>' +
      '</span></div>');
  }
  if (!rows.length) {
    rows.push('<div class="fs-empty">' +
      (onlyUnused ? '这个目录里没有被引用的素材（或还没做体检）<br>提示：勾选「只看未引用素材」前先跑一次 模组体检' :
        (q ? '没有匹配「' + esc(q) + '」的条目' : '这个目录是空的（或按当前筛选没有内容）')) + '</div>');
  }
  box.innerHTML = rows.join('');
  fsLazyThumbs(box);
  box.scrollTop = st0; box.scrollLeft = sl0;

  const nu = S.fs.files.filter(f => (f.kind === 'image' || f.kind === 'audio') && fsAssetState(f.name.toLowerCase()) === 'unused').length;
  $('#fsFoot').innerHTML =
    '<span>' + S.fs.dirs.length + ' 个文件夹 / ' + S.fs.files.length + ' 个文件' +
    (q || onlyUnused ? '（显示 ' + shown + ' 个）' : '') + '</span>' +
    (unused ? '<span class="au-tag ' + (nu ? '' : 'glob') + '">本目录未引用素材 ' + nu + '</span>' : '') +
    '<span class="grow"></span>' +
    (S.fs.modRoot ? '<span title="' + esc(S.fs.modRoot) + '">模组根：' + esc(S.fs.modRoot.split('\\').pop()) + '</span>' : '');
  fsUpdateSelbar();
}

/* ---- 行操作 ---- */
async function fsOpenInEditor(path) {
  const d = await (await fetch('/api/file/load?path=' + encodeURIComponent(path))).json();
  if (d.error || d.text == null) { toast(d.error || '读不到文件内容', 'err'); return; }
  if (S.doc.dirty && S.doc.path && !confirm('当前文件有未保存的修改，确定打开另一个文件吗？')) return;
  S.doc.sections = parseIni(d.text);
  S.doc.path = d.path; S.doc.name = d.name; markDirty(false);
  S.ui.activeSection = S.doc.sections[0] ? S.doc.sections[0].id : null;
  renderAll(); switchTab('effect');
  toast('已打开 <b>' + esc(d.name) + '</b>（' + S.doc.sections.length + ' 段）', 'ok');
  scheduleBackgroundScan(900);          // 换文件/换模组后重新识别全局变量（优先复用扫描缓存）
}

async function fsPreview(path, kind) {
  const name = path.split('\\').pop();
  if (kind === 'audio') {
    openModal('🎵 ' + name, '<div class="preview-box"><audio controls autoplay src="/api/file/raw?path=' +
      encodeURIComponent(path) + '"></audio></div>' +
      '<div class="preview-kv"><span><b>路径</b> ' + esc(path) + '</span></div>',
      '<button class="btn" id="mClose">关闭</button>');
  } else {
    openModal('🖼 ' + name, '<div class="preview-box"><img src="/api/file/raw?path=' +
      encodeURIComponent(path) + '" alt=""></div>' +
      '<div class="preview-kv"><span><b>路径</b> ' + esc(path) + '</span></div>',
      '<button class="btn" id="mClose">关闭</button>');
  }
  $('#mClose').onclick = closeModal;
}

async function fsReveal(path) {
  const d = await (await fetch('/api/fs/reveal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path })
  })).json();
  if (d.error) toast(esc(d.error), 'err');
}

async function fsRename(path) {
  const old = path.split('\\').pop();
  const name = prompt('重命名为：', old);
  if (!name || name === old) return;
  const d = await (await fetch('/api/fs/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path, name: name })
  })).json();
  if (d.error) { toast(esc(d.error), 'err'); return; }
  if (S.doc.path === path) { S.doc.path = d.path; S.doc.name = name; $('#fileName').textContent = name; }
  toast('已重命名为 <b>' + esc(name) + '</b>', 'ok');
  S.scan = null;
  fsGo(S.fs.path, true);
}

async function fsTrash(path) {
  const name = path.split('\\').pop();
  if (!confirm('把「' + name + '」移到回收站文件夹？\n\n不会真的删除：会移动到模组根目录下的 _回收站_时间戳 文件夹，随时可以找回。')) return;
  const d = await (await fetch('/api/fs/trash', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path })
  })).json();
  if (d.error) { toast(esc(d.error), 'err'); return; }
  if (S.doc.path === path) { S.doc.path = null; markDirty(false); }
  toast('已移到 <b>' + esc(d.movedTo) + '</b>', 'ok', 5000);
  S.scan = null;
  fsGo(S.fs.path, true);
}

async function fsNewDir() {
  const name = prompt('新文件夹名称：', '新文件夹');
  if (!name) return;
  const d = await (await fetch('/api/fs/mkdir', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: S.fs.path, name: name })
  })).json();
  if (d.error) { toast(esc(d.error), 'err'); return; }
  toast('已新建文件夹 <b>' + esc(name) + '</b>', 'ok');
  fsGo(S.fs.path, true);
}

function fsNewUnit() {
  openModal('新建单位文件', TEMPLATES.map((t, i) =>
    '<div class="tpl-card" data-newtpl="' + i + '"><h4>' + esc(t.name) + '</h4><p>' + esc(t.desc) + '</p></div>').join('') +
    '<div class="form-row" style="margin-top:10px"><label>文件名</label>' +
    '<input id="nfName" value="新单位.ini" spellcheck="false"></div>' +
    '<div class="hint" style="text-align:left">会创建在：' + esc(S.fs.path) + '</div>',
    '<button class="btn" id="mClose">取消</button>');
  let tplIdx = 1;
  const draw = () => $$('[data-newtpl]').forEach(c =>
    c.style.borderColor = (parseInt(c.dataset.newtpl, 10) === tplIdx) ? 'var(--amber)' : '');
  draw();
  $('#modalBody').onclick = ev => {
    const c = ev.target.closest('[data-newtpl]');
    if (!c) return;
    tplIdx = parseInt(c.dataset.newtpl, 10);
    draw();
  };
  $('#mClose').onclick = closeModal;
  openModal('新建单位文件', $('#modalBody').innerHTML,
    '<button class="btn primary" id="nfOk">创建并打开</button><button class="btn" id="mClose">取消</button>');
  draw();
  $('#nfOk').onclick = async () => {
    const name = ($('#nfName').value || '').trim() || '新单位.ini';
    const text = serialize({ sections: TEMPLATES[tplIdx].build() }, { blank: true, comment: false });
    const d = await (await fetch('/api/fs/newfile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: S.fs.path, name: name, text: text })
    })).json();
    if (d.error) { toast(esc(d.error), 'err'); return; }
    closeModal();
    toast('已创建 <b>' + esc(d.name) + '</b>', 'ok');
    await fsGo(S.fs.path, true);
    fsOpenInEditor(d.path);
  };
}

/* ---- 右键菜单 ---- */
function closeCtx() {
  const m = $('#ctxMenu');
  if (m) m.remove();
}
function openCtx(x, y, items, title) {
  closeCtx();
  const m = document.createElement('div');
  m.className = 'ctx-menu';
  m.id = 'ctxMenu';
  m.innerHTML = (title ? '<div class="ttl">' + esc(title) + '</div>' : '') +
    items.map((it, i) => it.sep ? '<div class="sep"></div>' :
      '<button data-ctx="' + i + '"' + (it.danger ? ' class="danger"' : '') + '>' + it.label + '</button>').join('');
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 6)) + 'px';
  m.onclick = ev => {
    const b = ev.target.closest('[data-ctx]');
    if (!b) return;
    const it = items[parseInt(b.dataset.ctx, 10)];
    closeCtx();
    if (it && it.run) it.run();
  };
  return m;
}
function fsCtxMenu(ev, isDir, path) {
  ev.preventDefault();
  return fsCtxMenuWithPath(ev, isDir, path);
}
function fsCtxMenuWithPath(ev, isDir, path, forcedKind) {
  const kind = forcedKind || (isDir ? 'dir' : file_kind_js(path.split('\\').pop()));
  const items = [];
  if (isDir) {
    items.push({ label: '📂 打开这个文件夹', run: () => fsGo(path) });
    items.push({ label: '🔍 在模组里搜索内容', run: () => openOpenModal(path) });
    items.push({ label: '🏠 设为模组根目录', run: () => {
      S.modRoot = path; S.scan = null;
      fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modRoot: path }) }).catch(() => {});
      toast('已把模组根设为 <b>' + esc(path) + '</b>', 'ok');
      renderFs();
    } });
    items.push({ sep: true });
    items.push({ label: '＋ 在这里新建文件夹', run: fsNewDir });
    items.push({ label: '＋ 在这里新建单位文件', run: fsNewUnit });
  } else {
    if (kind === 'ini') items.push({ label: '✎ 在编辑器里打开', run: () => fsOpenInEditor(path) });
    if (kind === 'image' || kind === 'audio') items.push({ label: '👁 预览', run: () => fsPreview(path, kind) });
    items.push({ label: '🖥 用系统默认程序打开', run: async () => {
      const d = await (await fetch('/api/fs/open', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path }) })).json();
      if (d.error) toast(esc(d.error), 'err');
    } });
    items.push({ label: '📂 在 Windows 资源管理器里定位', run: () => fsReveal(path) });
    items.push({ label: '⧉ 复制完整路径', run: () =>
      navigator.clipboard.writeText(path).then(() => toast('已复制路径', 'ok'), () => {}) });
    items.push({ sep: true });
    items.push({ label: '✏ 重命名', run: () => fsRename(path) });
    items.push({ label: '🗑 移到回收站文件夹', danger: true, run: () => fsTrash(path) });
  }
  openCtx(ev.clientX, ev.clientY, items, path);
}

function bindFs() {
  try {
    const v = localStorage.getItem('rt_fs_view');
    if (v === 'grid' || v === 'list') S.ui.fsView = v;
    const s = localStorage.getItem('rt_fs_sort');
    if (s) S.ui.fsSort = s;
  } catch (e) { /* 忽略 */ }
  if ($('#fsSort')) $('#fsSort').value = S.ui.fsSort;
  fsSyncViewButtons();

  $$('.side-tab').forEach(b => b.onclick = () => switchSide(b.dataset.side));
  $('#fsUp').onclick = () => S.fs.parent && fsGo(S.fs.parent);
  $('#fsMod').onclick = () => {
    const target = S.modRoot || S.fs.modRoot || S.fs.path;
    if (!target) { toast('还没确定模组目录，先用「打开」选一个', '', 3600); return; }
    S.modRoot = target;
    fsGo(target);
  };
  $('#fsRefresh').onclick = () => { S.scan = null; fsGo(S.fs.path, true); };
  $('#fsReveal').onclick = () => S.fs.path && fsReveal(S.fs.path);
  $('#fsFind').onclick = () => openOpenModal(S.fs.path);
  $('#fsPath').onkeydown = e => { if (e.key === 'Enter') fsGo(e.target.value.trim()); };
  $('#fsFilter').oninput = debounce(renderFs, 120);
  $('#fsKinds').onchange = () => fsGo(S.fs.path, true);
  $('#fsCrumbs').onclick = ev => {
    const b = ev.target.closest('[data-fsgo]');
    if (b) fsGo(b.dataset.fsgo);
  };
  $('#fsSort').onchange = e => {
    S.ui.fsSort = e.target.value;
    try { localStorage.setItem('rt_fs_sort', S.ui.fsSort); } catch (err) { /* 忽略 */ }
    renderFs();
  };
  const setView = v => {
    S.ui.fsView = v;
    try { localStorage.setItem('rt_fs_view', v); } catch (err) { /* 忽略 */ }
    fsSyncViewButtons();
    renderFs();
  };
  $('#fsViewList').onclick = () => setView('list');
  $('#fsViewGrid').onclick = () => setView('grid');
  $('#fsSelect').onclick = () => {
    S.ui.fsSelect = !S.ui.fsSelect;
    if (!S.ui.fsSelect) fsClearSel();
    fsSyncViewButtons();
    renderFs();
    if (S.ui.fsSelect) toast('多选模式：点条目勾选，可批量复制路径 / 移到回收站', '', 3000);
  };
  $('#fsSelbar').onclick = ev => {
    const b = ev.target.closest('[data-fsselcopy],[data-fsseltrash],[data-fsselclear]');
    if (!b) return;
    const paths = Array.from(S.ui.fsMulti || []);
    if (b.hasAttribute('data-fsselcopy')) {
      navigator.clipboard.writeText(paths.join('\n')).then(() => toast('已复制 ' + paths.length + ' 条路径', 'ok'), () => {});
    } else if (b.hasAttribute('data-fsseltrash')) {
      fsTrashMany(paths);
    } else {
      fsClearSel(); renderFs();
    }
  };
  if ($('#fsOnlyDup')) $('#fsOnlyDup').onchange = async e => {
    if (e.target.checked) {
      if ($('#fsOnlyUnused').checked) $('#fsOnlyUnused').checked = false;
      if (!(S.scan && S.scan.ok)) {
        toast('正在扫描模组，检测每个 ini/template 的重复键…', '', 3000);
        const bx = $('#fsList');
        if (bx) bx.innerHTML = '<div class="fs-empty">正在扫描模组，检测重复键…<br>大模组需要几秒</div>';
        await ensureScan(true);
      }
      if (!(S.scan && S.scan.ok)) { toast('扫描失败，无法列出重复键', 'err'); e.target.checked = false; }
      else {
        const dq = S.scan.duplicates || {};
        toast(dq.fileCount ? '全模组有 ' + dq.fileCount + ' 个文件、' + (dq.keyCount || 0) + ' 处段内重复键' :
          '没有发现段内重复键', dq.fileCount ? 'err' : 'ok', 3400);
      }
    }
    renderFs();
  };
  $('#fsOnlyUnused').onchange = async e => {
    if (e.target.checked) {
      if ($('#fsOnlyDup') && $('#fsOnlyDup').checked) $('#fsOnlyDup').checked = false;
      if (S.ui.fsSort === 'name-asc') {
        S.ui.fsSort = 'size-desc';
        if ($('#fsSort')) $('#fsSort').value = S.ui.fsSort;
        try { localStorage.setItem('rt_fs_sort', S.ui.fsSort); } catch (err) { /* 忽略 */ }
      }
      if (!(S.scan && S.scan.ok)) {
        toast('正在扫描模组，判断哪些素材没被引用…', '', 3000);
        await ensureScan(true);
      }
      if (!(S.scan && S.scan.ok)) { toast('扫描失败，无法列出未引用素材', 'err'); e.target.checked = false; }
      else toast('下面是全模组里没被任何 ini 引用的素材', 'ok', 3000);
    }
    renderFs();
  };
  $('#fsNewFile').onclick = fsNewUnit;
  $('#fsNewDir').onclick = fsNewDir;

  const list = $('#fsList');
  const openRow = (rowOrPath, kind) => {
    let path, k;
    if (typeof rowOrPath === 'string') { path = rowOrPath; k = kind; }
    else { path = fsPathOfRow(rowOrPath); k = rowOrPath.classList.contains('isdir') ? 'dir' : rowOrPath.dataset.kind; }
    if (!path) return;
    if (k === 'dir') fsGo(path);
    else if (k === 'ini') fsOpenInEditor(path);
    else if (k === 'image' || k === 'audio') fsPreview(path, k);
    else fsReveal(path);
  };
  list.onclick = async ev => {
    const row = ev.target.closest('.fs-row');
    if (!row) { list.focus({ preventScroll: true }); return; }
    const chk = ev.target.closest('[data-fscheck]');
    if (chk) { fsToggleSel(chk.dataset.fscheck, chk.checked); renderFs(); return; }
    const act = ev.target.closest('[data-fsedit],[data-fsview],[data-fsopen],[data-fsreveal],[data-fsrename],[data-fstrash],[data-fscopy],[data-fsmenu]');
    if (act) {
      const t = act.dataset;
      if (t.fsedit) return fsOpenInEditor(t.fsedit);
      if (t.fsview) return fsPreview(t.fsview, row.dataset.kind);
      if (t.fsopen) return fsGo(t.fsopen);
      if (t.fsreveal) return fsReveal(t.fsreveal);
      if (t.fsrename) return fsRename(t.fsrename);
      if (t.fstrash) return fsTrash(t.fstrash);
      if (t.fscopy) return navigator.clipboard.writeText(t.fscopy)
        .then(() => toast('已复制路径', 'ok'), () => {});
      if (t.fsmenu) {
        const r = act.getBoundingClientRect();
        const path = t.fsmenu;
        const isDir = !row.dataset.kind || row.classList.contains('isdir');
        const fake = { preventDefault() {}, clientX: Math.min(r.left, window.innerWidth - 200), clientY: r.bottom + 4 };
        fsCtxMenuWithPath(fake, isDir, path);
        return;
      }
    }
    const path = fsPathOfRow(row);
    if (S.ui.fsSelect) {
      if (path) { fsToggleSel(path); renderFs(); }
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      if (path) { fsToggleSel(path); S.ui.fsAnchor = path; renderFs(); }
      return;
    }
    if (ev.shiftKey && S.ui.fsAnchor && path) {
      fsSelectRange(S.ui.fsAnchor, path); renderFs(); return;
    }
    list.focus({ preventScroll: true });
    if (row.dataset.dir) { fsGo(row.dataset.dir); return; }
    if (isTouch() && row.dataset.file && row.dataset.kind === 'ini') { fsOpenInEditor(row.dataset.file); return; }
    if (S.ui.fsMulti.size) fsClearSel();
    S.fs.sel = path;
    S.ui.fsAnchor = path;
    $$('#fsList .fs-row').forEach(r => r.classList.toggle('sel', r === row));
  };
  list.ondblclick = ev => {
    if (S.ui.fsSelect) return;
    const row = ev.target.closest('.fs-row');
    if (!row) return;
    openRow(row);
  };
  list.onkeydown = ev => {
    if (ev.target !== list) return;
    const rows = $$('#fsList .fs-row').filter(r => !r.classList.contains('fs-empty'));
    if (!rows.length) return;
    const cur = rows.findIndex(r => fsPathOfRow(r) === S.fs.sel);
    const move = delta => {
      const i = Math.max(0, Math.min(rows.length - 1, (cur < 0 ? 0 : cur) + delta));
      const r = rows[i];
      if (!r) return;
      const oldAnchor = S.ui.fsAnchor;
      S.fs.sel = fsPathOfRow(r);
      if (ev.shiftKey && oldAnchor) fsSelectRange(oldAnchor, S.fs.sel);
      else { fsClearSel(); S.ui.fsAnchor = S.fs.sel; }
      renderFs();
      const nr = $$('#fsList .fs-row').find(x => fsPathOfRow(x) === S.fs.sel);
      if (nr) nr.scrollIntoView({ block: 'nearest' });
    };
    if (ev.key === 'ArrowDown') { move(1); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { move(-1); ev.preventDefault(); }
    else if (ev.key === 'Enter') {
      const r = rows[cur < 0 ? 0 : cur];
      if (r) openRow(r);
      ev.preventDefault();
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (S.ui.fsMulti.size) fsTrashMany(Array.from(S.ui.fsMulti));
      else if (S.fs.sel) fsTrash(S.fs.sel);
      ev.preventDefault();
    } else if (ev.key === 'F2') {
      if (S.fs.sel) fsRename(S.fs.sel);
      ev.preventDefault();
    } else if (ev.key === 'Escape') {
      if (S.ui.fsSelect) { S.ui.fsSelect = false; fsClearSel(); fsSyncViewButtons(); renderFs(); }
      else { fsClearSel(); S.fs.sel = null; renderFs(); }
      ev.preventDefault();
    } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A') && S.ui.fsSelect) {
      rows.forEach(r => { const p = fsPathOfRow(r); if (p) S.ui.fsMulti.add(p); });
      fsUpdateSelbar(); renderFs();
      ev.preventDefault();
    }
  };
  list.oncontextmenu = ev => {
    const row = ev.target.closest('.fs-row');
    if (!row) return;
    if (row.dataset.dir) fsCtxMenu(ev, true, row.dataset.dir);
    else fsCtxMenu(ev, false, row.dataset.file);
  };
  document.addEventListener('click', ev => {
    if (!ev.target.closest('.ctx-menu') && !ev.target.closest('#fsList')) closeCtx();
  });
  window.addEventListener('blur', closeCtx);
}

function switchSide(which) {
  S.ui.side = which;
  if (which === 'fs') {
    $$('.mobnav-btn').forEach(b => b.classList.toggle('active', b.dataset.mv === 'fs'));
  } else {
    $$('.mobnav-btn').forEach(b => b.classList.toggle('active', b.dataset.mv === 'lib'));
  }
  $$('.side-tab').forEach(b => b.classList.toggle('active', b.dataset.side === which));
  $('#sideLib').classList.toggle('hidden', which !== 'lib');
  $('#sideFs').classList.toggle('hidden', which !== 'fs');
  if (which === 'fs') {
    if (!S.fs.path) fsGo(S.modRoot || '');
    else renderFs();
  }
}

/* ============================================================
   面板缩放 / 右侧栏
   ============================================================ */
function layoutDefaults() {
  const w = window.innerWidth;
  if (w < 1100) return { left: 264, right: 370 };
  if (w < 1400) return { left: 280, right: 400 };
  return { left: 296, right: 420 };
}
function layoutMins() {
  const w = window.innerWidth;
  if (w < 900) return { left: 200, mid: 270, right: 250 };
  if (w < 1100) return { left: 200, mid: 310, right: 260 };
  return { left: 220, mid: 340, right: 300 };
}
function clampNum(v, a, b) { return Math.max(a, Math.min(b, v)); }
function loadLayoutPrefs() {
  try {
    const l = parseFloat(localStorage.getItem('rt_left_w'));
    const r = parseFloat(localStorage.getItem('rt_right_w'));
    if (isFinite(l) && isFinite(r)) {
      S.ui.leftW = l; S.ui.rightW = r; S.ui._layoutSaved = true;
    }
    const open = localStorage.getItem('rt_sidebar_open');
    if (open === '0' || open === '1') { S.ui.sidebarOpen = open === '1'; }
  } catch (e) { /* 忽略 */ }
}
function saveLayoutPrefs() {
  try {
    localStorage.setItem('rt_left_w', String(Math.round(S.ui.leftW)));
    localStorage.setItem('rt_right_w', String(Math.round(S.ui.rightW)));
    localStorage.setItem('rt_sidebar_open', S.ui.sidebarOpen ? '1' : '0');
  } catch (e) { /* 忽略 */ }
}
function syncSidebarUI() {
  const layout = document.querySelector('.layout');
  const rp = $('#rightPanel');
  const collapsed = !S.ui.sidebarOpen && window.innerWidth > 820;
  if (rp) rp.classList.toggle('collapsed', collapsed);
  if (layout) layout.classList.toggle('sidebar-collapsed', collapsed);
  const btn = $('#btnSidebarFold');
  if (btn) {
    const open = S.ui.sidebarOpen;
    btn.textContent = open ? '⟩' : '⟨';
    btn.title = open ? '收起侧栏' : '展开侧栏';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  const topBtn = $('#btnSidebar');
  if (topBtn) {
    topBtn.classList.toggle('on', !!S.ui.sidebarOpen);
    topBtn.setAttribute('aria-expanded', S.ui.sidebarOpen ? 'true' : 'false');
  }
  $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.sidebarTab === S.ui.tab));
}
function applyLayout() {
  const layout = document.querySelector('.layout');
  if (!layout) return;
  const mobile = window.innerWidth <= 820;
  if (S.ui._wasMobile !== mobile) {
    S.ui._wasMobile = mobile;
    setTimeout(refreshSidebarTab, 100);
  }
  if (mobile) {
    layout.style.removeProperty('--left-w');
    layout.style.removeProperty('--right-w');
    layout.classList.remove('sidebar-collapsed');
    const rp = $('#rightPanel'); if (rp) rp.classList.remove('collapsed');
    syncSidebarUI();
    syncMobSave();
    return;
  }
  const mins = layoutMins();
  const d = layoutDefaults();
  let l = clampNum(isFinite(S.ui.leftW) ? S.ui.leftW : d.left, mins.left, 560);
  let rDesired = clampNum(isFinite(S.ui.rightW) ? S.ui.rightW : d.right, mins.right, 820);
  let r = S.ui.sidebarOpen ? rDesired : 46;
  const avail = window.innerWidth - 24 - 20;
  if (S.ui.sidebarOpen) {
    const over = l + r + mins.mid - avail;
    if (over > 0) {
      const total = Math.max(1, l + r);
      l = Math.max(mins.left, l - over * (l / total));
      r = Math.max(mins.right, r - over * (r / total));
    }
    if (l + r + mins.mid > avail) {
      r = Math.max(mins.right, r - (l + r + mins.mid - avail));
      if (l + r + mins.mid > avail) l = Math.max(mins.left, l - (l + r + mins.mid - avail));
    }
  }
  // 极窄桌面兜底：保证中间的编辑器还有空间
  if (l + r + mins.mid > avail) {
    const over = l + r + mins.mid - avail;
    if (S.ui.sidebarOpen) r = Math.max(46, r - over);
    else l = Math.max(160, l - over);
  }
  layout.style.setProperty('--left-w', Math.round(l) + 'px');
  layout.style.setProperty('--right-w', Math.round(r) + 'px');
  const sl = $('#splitLeft'), sr = $('#splitRight');
  if (sl) {
    sl.setAttribute('aria-valuenow', Math.round(l));
    sl.setAttribute('aria-valuemin', mins.left);
    sl.setAttribute('aria-valuemax', 560);
  }
  if (sr) {
    sr.setAttribute('aria-valuenow', Math.round(r));
    sr.setAttribute('aria-valuemin', S.ui.sidebarOpen ? mins.right : 46);
    sr.setAttribute('aria-valuemax', 820);
  }
  syncSidebarUI();
  syncMobSave();
}
function setSidebarOpen(open) {
  const wasOpen = S.ui.sidebarOpen;
  S.ui.sidebarOpen = !!open;
  saveLayoutPrefs();
  applyLayout();
  if (!wasOpen && S.ui.sidebarOpen) setTimeout(refreshSidebarTab, 80);
}
function refreshSidebarTab() {
  try {
    if (S.ui.tab === 'bag') { renderBag(); renderBagMiss(); }
    else if (S.ui.tab === 'effect') renderEffect();
    else if (S.ui.tab === 'check') renderCheck();
    else if (S.ui.tab === 'ref') renderRef();
  } catch (e) { /* 单个页签渲染失败不影响布局 */ }
}
function bindLayout() {
  loadLayoutPrefs();
  if (!S.ui._layoutSaved) {
    const d = layoutDefaults();
    S.ui.leftW = d.left; S.ui.rightW = d.right;
  }
  applyLayout();

  const startDrag = (ev, side) => {
    if (ev.button !== 0 || window.innerWidth <= 820) return;
    if (side === 'right' && !S.ui.sidebarOpen) return;
    ev.preventDefault();
    const el = side === 'left' ? $('#splitLeft') : $('#splitRight');
    const startX = ev.clientX;
    const startW = side === 'left' ? S.ui.leftW : S.ui.rightW;
    let raf = 0, lastX = ev.clientX;
    if (el) el.classList.add('dragging');
    document.body.classList.add('col-resizing');
    const onMove = e => {
      lastX = e.clientX;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const dx = lastX - startX;
        const mins = layoutMins();
        let w = side === 'left' ? startW + dx : startW - dx;
        w = clampNum(w, side === 'left' ? mins.left : mins.right, side === 'left' ? 560 : 820);
        if (side === 'left') S.ui.leftW = w; else S.ui.rightW = w;
        applyLayout();
      });
    };
    const onUp = () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (el) el.classList.remove('dragging');
      document.body.classList.remove('col-resizing');
      saveLayoutPrefs();
      if (side === 'right' && S.ui.sidebarOpen) setTimeout(refreshSidebarTab, 80);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const sl = $('#splitLeft'), sr = $('#splitRight');
  if (sl) {
    sl.addEventListener('pointerdown', ev => startDrag(ev, 'left'));
    sl.addEventListener('dblclick', () => {
      const d = layoutDefaults();
      S.ui.leftW = d.left; S.ui.rightW = d.right;
      saveLayoutPrefs(); applyLayout();
      setTimeout(refreshSidebarTab, 80);
    });
    sl.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        const step = ev.shiftKey ? 40 : 8;
        S.ui.leftW = clampNum(S.ui.leftW + (ev.key === 'ArrowRight' ? step : -step), layoutMins().left, 560);
        saveLayoutPrefs(); applyLayout(); ev.preventDefault();
      } else if (ev.key === 'Home') {
        const d = layoutDefaults();
        S.ui.leftW = d.left; S.ui.rightW = d.right;
        saveLayoutPrefs(); applyLayout();
        setTimeout(refreshSidebarTab, 80);
        ev.preventDefault();
      }
    });
  }
  if (sr) {
    sr.addEventListener('pointerdown', ev => startDrag(ev, 'right'));
    sr.addEventListener('dblclick', ev => {
      if (ev.target.closest('button')) return;
      const d = layoutDefaults();
      S.ui.leftW = d.left;
      S.ui.rightW = d.right;
      S.ui.sidebarOpen = true;
      saveLayoutPrefs(); applyLayout();
      setTimeout(refreshSidebarTab, 80);
    });
    sr.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        if (!S.ui.sidebarOpen) return;
        const step = ev.shiftKey ? 40 : 8;
        S.ui.rightW = clampNum(S.ui.rightW + (ev.key === 'ArrowLeft' ? step : -step), layoutMins().right, 820);
        saveLayoutPrefs(); applyLayout();
        setTimeout(refreshSidebarTab, 80);
        ev.preventDefault();
      } else if (ev.key === 'Home') {
        const d = layoutDefaults();
        S.ui.leftW = d.left; S.ui.rightW = d.right;
        S.ui.sidebarOpen = true;
        saveLayoutPrefs(); applyLayout();
        setTimeout(refreshSidebarTab, 80);
        ev.preventDefault();
      }
    });
  }
  const fold = $('#btnSidebarFold');
  if (fold) {
    fold.addEventListener('pointerdown', ev => ev.stopPropagation());
    fold.addEventListener('click', ev => {
      ev.stopPropagation();
      setSidebarOpen(!S.ui.sidebarOpen);
    });
  }
  const topBtn = $('#btnSidebar');
  if (topBtn) topBtn.addEventListener('click', () => setSidebarOpen(!S.ui.sidebarOpen));
  $$('.rail-btn').forEach(b => b.addEventListener('click', () => {
    if (!S.ui.sidebarOpen) setSidebarOpen(true);
    switchTab(b.dataset.sidebarTab);
    syncSidebarUI();
  }));
  window.addEventListener('resize', debounce(() => {
    applyLayout();
    if (S.ui.sidebarOpen || window.innerWidth <= 820) setTimeout(refreshSidebarTab, 80);
  }, 120));
  syncSidebarUI();
}

/* ============================================================
   21. 贴图与特效预览
   ============================================================ */
const SPRITE_CACHE = {};      // 解析出的绝对路径 -> {state, img}
const ASSET_REF_CACHE = {};   // ini|ref -> 解析结果
const ASSET_REF_PENDING = new Map(); // ini|ref -> 等待中的回调（同一贴图只发一次请求）
const ASSET_RESOLVE_QUEUE = [];
let ASSET_RESOLVE_ACTIVE = 0;
const ASSET_RESOLVE_MAX = 4;   // 同时最多解析 4 个贴图，避免几十个 arm 一起请求把浏览器连接打满
const ANIM = { list: [], raf: 0, last: 0 };

function animAdd(fn) { ANIM.list.push(fn); }
function animRun() {
  if (ANIM.raf) return;
  const step = t => {
    if (t - ANIM.last > 70) {
      ANIM.last = t;
      // 动画制作器打开时，背后的动画卡片没必要继续画（还会让遮罩模糊反复重算）
      const studioOpen = $('#studio') && !$('#studio').classList.contains('hidden');
      if (!studioOpen) {
        for (const f of ANIM.list.slice()) { try { f(t); } catch (e) { /* 忽略单个画布的错误 */ } }
      }
    }
    ANIM.raf = requestAnimationFrame(step);
  };
  ANIM.raf = requestAnimationFrame(step);
}

function loadSprite(path) {
  let e = SPRITE_CACHE[path];
  if (!e) {
    e = { state: 'loading', img: new Image(), tries: 0 };
    try { e.img.fetchPriority = 'high'; e.img.decoding = 'async'; } catch (err) { /* 旧浏览器忽略 */ }
    const src = '/api/file/raw?path=' + encodeURIComponent(path);
    e.img.onload = () => { e.state = 'ok'; redrawSprites(); };
    e.img.onerror = () => {
      // 扫描大模组时单张图可能被挤到超时；失败后重试一次，不要永久缓存成裂图
      if (e.tries < 1) {
        e.tries++;
        e.state = 'loading';
        setTimeout(() => { e.img.src = src + '&retry=' + Date.now(); }, 800);
      } else {
        e.state = 'err';
        redrawSprites();
      }
    };
    e.img.src = src;
    SPRITE_CACHE[path] = e;
  }
  return e;
}

let _redrawing = false;
let _redrawTimer = 0;
function redrawSprites() {
  // 贴图解析回调可能一次来几十个，合并成一次重绘，避免 arm 多时连续卡帧
  if (_redrawing) { S.ui._pendingRedraw = true; return; }
  if (_redrawTimer) return;
  _redrawTimer = setTimeout(() => {
    _redrawTimer = 0;
    _redrawing = true;
    try {
      const studioOpen = $('#studio') && !$('#studio').classList.contains('hidden');
      // 制作器打开时背后效果预览不必跟着每张 arm 贴图解析重画，等关闭时再补一次
      if (!studioOpen && !$('#tabEffect').classList.contains('hidden')) renderEffect();
      if (studioOpen && typeof studioRefreshPartPreview === 'function') {
        studioRefreshPartPreview();
        if (typeof studioDrawOnly === 'function') studioDrawOnly();
      }
    } finally {
      _redrawing = false;
      if (S.ui._pendingRedraw) { S.ui._pendingRedraw = false; setTimeout(redrawSprites, 0); }
    }
  }, 60);
}

function pumpAssetResolve() {
  while (ASSET_RESOLVE_ACTIVE < ASSET_RESOLVE_MAX && ASSET_RESOLVE_QUEUE.length) {
    const task = ASSET_RESOLVE_QUEUE.shift();
    ASSET_RESOLVE_ACTIVE++;
    Promise.resolve().then(task).catch(() => {}).finally(() => {
      ASSET_RESOLVE_ACTIVE--;
      pumpAssetResolve();
    });
  }
}

/** 解析引用（异步，结果缓存）；解析完成后重绘一次 */
function resolveRef(ref, cb, iniPath) {
  const key = (iniPath || S.doc.path || '') + '|' + ref;
  const hit = ASSET_REF_CACHE[key];
  if (hit) { if (cb) cb(hit); return hit; }
  // 同一个贴图正在解析时只登记回调，绝不再发请求；
  // 否则部件多的单位每帧都会对同一批 arm 贴图重复发 resolve。
  if (ASSET_REF_PENDING.has(key)) {
    if (cb) ASSET_REF_PENDING.get(key).push(cb);
    return null;
  }
  const callbacks = cb ? [cb] : [];
  ASSET_REF_PENDING.set(key, callbacks);
  let finished = false;
  const finish = d => {
    if (finished) return;
    finished = true;
    ASSET_REF_CACHE[key] = d;
    ASSET_REF_PENDING.delete(key);
    for (const fn of callbacks) { try { fn(d); } catch (e) { /* 忽略单个回调 */ } }
    redrawSprites();
  };
  const url = '/api/asset/resolve?ini=' + encodeURIComponent(iniPath || S.doc.path || '') +
    '&ref=' + encodeURIComponent(ref);
  ASSET_RESOLVE_QUEUE.push(() => {
    return fetch(url).then(r => r.json()).then(d => {
      if (d.kind === 'file') loadSprite(d.path);
      finish(d);
    }).catch(() => finish({ kind: 'missing', name: ref }));
  });
  pumpAssetResolve();
  return null;
}

/** 取引用的贴图状态（不会同步触发重绘，避免递归） */
function spriteOf(ref, iniPath) {
  const key = (iniPath || S.doc.path || '') + '|' + ref;
  const res = ASSET_REF_CACHE[key];
  if (!res) {
    resolveRef(ref, null, iniPath);
    return { kind: 'loading', ref: ref };
  }
  if (res.kind !== 'file') return { kind: res.kind, ref: ref, info: res };
  const sp = loadSprite(res.path);
  return { kind: 'file', ref: ref, path: res.path, state: sp.state, img: sp.img };
}

/** 在画布上按“原始像素 × 比例尺”画贴图（忠实还原 RW 的绘制尺寸） */
function drawSpriteOn(ctx, entry, x, y, scale, frames, fw, fh, tMs, opt) {
  opt = opt || {};
  if (!entry || entry.state !== 'ok') return false;
  const img = entry.img;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  let useFw = fw, useFh = fh;
  if (frames > 1 && useFw <= 0 && img.width >= frames &&
      (img.width % frames === 0 || opt.autoFrame)) {
    useFw = Math.max(1, Math.floor(img.width / frames)); useFh = img.height;   // 等宽贴图条自动算单帧
  }
  if (frames > 1 && useFw > 0 && useFh > 0 && img.width >= useFw) {
    const perRow = Math.max(1, Math.floor(img.width / useFw));
    const idx = (opt.frame !== undefined) ? (opt.frame % frames)
      : (Math.floor((tMs || 0) / (1000 / 12)) % frames);
    sx = (idx % perRow) * useFw;
    sy = Math.floor(idx / perRow) * useFh;
    sw = useFw; sh = useFh;
  }
  const w = sw * scale, h = sh * scale;
  ctx.imageSmoothingEnabled = false;
  if (opt.dir) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(opt.dir * Math.PI / 180);
    ctx.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(img, sx, sy, sw, sh, x - w / 2, y - h / 2, w, h);
  }
  return true;
}

/* 其它文件里定义的段（模组常把特效库写在 .md 里，靠 copyFrom 引用） */
const REMOTE_SEC = {};
function fetchRemoteSection(path, secName, cb) {
  const key = path + '|' + secName;
  if (REMOTE_SEC[key] !== undefined) { cb(REMOTE_SEC[key]); return; }
  REMOTE_SEC[key] = null;                      // 占位，避免并发重复请求
  fetch('/api/file/load?path=' + encodeURIComponent(path)).then(r => r.json()).then(d => {
    if (d.error || d.text == null) { cb(null); return; }
    const low = secName.toLowerCase();
    const sec = parseIni(d.text).find(x => String(x.name).toLowerCase() === low);
    REMOTE_SEC[key] = sec || null;
    if (sec) redrawSprites();
    cb(sec || null);
  }).catch(() => { REMOTE_SEC[key] = null; cb(null); });
}

/* ---------- 帧分割：严格按代码填的 frame_width/frame_height/total_frames 切分 ----------
 * RW 的贴图条：等宽横排；decals 也支持 frame_width/frame_height（与 total_frames 二选一）。 */
function frameSplitSpec(im, m) {
  m = m || {};
  const declared = Math.max(1, num(m.total_frames, 1));
  let fw = num(m.frame_width, 0), fh = num(m.frame_height, 0);
  let cols = 1, rows = 1, count = 1;
  if (fw > 0 && fh > 0 && im.width >= fw && im.height >= fh) {
    // 代码明确给了帧尺寸：严格按它切
    cols = Math.max(1, Math.floor(im.width / fw));
    rows = Math.max(1, Math.floor(im.height / fh));
    count = declared > 1 ? Math.min(declared, cols * rows) : cols * rows;
  } else if (declared > 1 && im.width % declared === 0) {
    // 只给了总帧数：按等宽横排推单帧尺寸
    fw = Math.floor(im.width / declared); fh = im.height;
    cols = declared; rows = 1; count = declared;
  } else {
    fw = im.width; fh = im.height; count = 1;
  }
  return { fw: fw, fh: fh, cols: cols, rows: rows, count: count };
}

/** progress(0~1) → 帧序号（支持 animateFrameStart/End/PingPong） */
function frameIdxAt(m, spec, progress) {
  const start = Math.max(0, num(m.animateFrameStart, 0));
  const endRaw = String(m.animateFrameEnd == null ? '' : m.animateFrameEnd).trim();
  const end = endRaw !== '' ? num(endRaw, spec.count - 1) : spec.count - 1;
  const lo = Math.min(start, spec.count - 1);
  const hi = Math.min(Math.max(end, lo), spec.count - 1);
  const count = Math.max(1, hi - lo + 1);
  const pp = /^true$/i.test(String(m.animateFramePingPong || ''));
  let k;
  if (pp) {
    const tri = (progress * 2) % 2;
    k = Math.min(count - 1, Math.floor((tri < 1 ? tri : 2 - tri) * count));
  } else {
    k = Math.min(count - 1, Math.floor(progress * count));
  }
  return { idx: lo + k, lo: lo, hi: hi, count: count, pingPong: pp };
}

/** 帧条：把切出的每个关键帧画成一排小格，当前帧高亮 */
function drawFilmStrip(ctx, W, H, im, spec, curIdx, y) {
  const count = spec.count;
  if (count <= 1) return;
  const maxCells = Math.min(count, 24);
  const stride = count > maxCells ? count / maxCells : 1;
  const cellH = 14;
  const cellW = Math.max(6, Math.min(20, (W - 12) / maxCells));
  const x0 = (W - cellW * maxCells) / 2;
  ctx.save();
  for (let i = 0; i < maxCells; i++) {
    const fIdx = Math.min(count - 1, Math.floor(i * stride));
    const sx = (fIdx % spec.cols) * spec.fw;
    const sy = Math.floor(fIdx / spec.cols) * spec.fh;
    const x = x0 + i * cellW;
    ctx.globalAlpha = 0.9;
    ctx.imageSmoothingEnabled = false;
    try {
      ctx.drawImage(im, sx, sy, spec.fw, spec.fh, x, y, cellW, cellH);
    } catch (e) { /* 越界忽略 */ }
    ctx.globalAlpha = 1;
    // 当前帧高亮
    const isCur = fIdx === curIdx || (stride > 1 && curIdx >= fIdx && curIdx < fIdx + stride);
    ctx.strokeStyle = isCur ? '#ffb02e' : 'rgba(255,255,255,.18)';
    ctx.lineWidth = isCur ? 1.6 : 1;
    ctx.strokeRect(x + .5, y + .5, cellW - 1, cellH - 1);
  }
  ctx.restore();
}

/* ---------- 效果预览里的贴图区 ---------- */
function renderFxPreview(U) {
  const box = $('#fxEffects');
  // 1) 单位本体贴图
  const gfx = U.gfx || {};
  const hero = $('#fxHero');
  const oldThumb = hero.querySelector('.sprite-thumb');
  if (oldThumb) oldThumb.remove();
  if (gfx.image && !/^(NONE|AUTO)$/i.test(String(gfx.image).trim())) {
    // 先同步问一次缓存；没有就异步补
    const res = ASSET_REF_CACHE[(S.doc.path || '') + '|' + gfx.image];
    const thumb = document.createElement('div');
    thumb.className = 'sprite-thumb';
    const imgHtml = res && res.kind === 'file'
      ? '<img src="/api/file/raw?path=' + encodeURIComponent(res.path) +
        '" loading="eager" decoding="async" fetchpriority="high" alt="">'
      : '<img alt="" style="opacity:.25">';
    const frames = num(gfx.total_frames, 1);
    const state = !res ? '<span class="st-meta">贴图解析中…</span>'
      : res.kind === 'file' ? '<span class="st-meta">贴图：<b>' + esc(res.name || '') + '</b>' +
          (res.found === 'byname' ? '（在模组里按文件名找到）' : '') +
          (frames > 1 ? '　' + frames + ' 帧' : '') + '</span>'
      : res.kind === 'builtin' ? '<span class="st-meta">贴图：<b>' + esc(res.name || gfx.image) + '</b>（游戏内置共享素材，无法预览）</span>'
      : '<span class="st-meta"><span class="miss">找不到贴图文件：' + esc(gfx.image) + '</span>' +
        '<br>放在单位 ini 同目录，或用 ROOT:/ 指向模组根</span>';
    thumb.innerHTML = imgHtml + '<div class="st-meta"><div>' + state + '</div>' +
      '<div>image: <b>' + esc(gfx.image) + '</b></div></div>';
    const himg = thumb.querySelector('img[src]');
    if (himg) himg.onerror = () => {
      if (himg.dataset.retried) return;
      himg.dataset.retried = '1';
      setTimeout(() => { himg.src += '&retry=' + Date.now(); }, 800);
    };
    hero.appendChild(thumb);
    if (!res) resolveRef(gfx.image, () => {});
  }

  // 2) 特效预览
  const fxSecs = S.doc.sections.filter(s => deriveSecId(s.name) === 'effect');
  let items = fxSecs.map(s => {
    const m = {};
    for (const e of s.entries) if (e.key) m[e.key] = e.value;
    return { name: String(s.name).replace(/^effect_/i, ''), sec: s, m: m };
  });
  // 单位本体贴图也放一张卡片，放大看
  if (gfx.image && !/^(NONE|AUTO)$/i.test(String(gfx.image).trim())) {
    items.unshift({ name: '单位本体（' + String(U.core.name || '未命名') + '）', m: gfx, unit: true });
  }
  // 本文件没定义、但模组别的文件（含 .md 特效库）里有的特效：也加载进来预览
  const remoteCand = missingRefs().filter(x => x.kind === 'effect' && x.level === 'info');
  const remoteReady = [];
  for (const r of remoteCand) {
    const idx = ((S.scan && S.scan.effects) || []).find(e => e.name === r.name);
    if (!idx) continue;
    const full = (S.scan.root || '').replace(/[\\/]+$/, '') + '\\' + idx.rel;
    const cacheKey = full + '|effect_' + r.name;
    let sec = REMOTE_SEC[cacheKey];
    if (sec === undefined) { fetchRemoteSection(full, 'effect_' + r.name, () => {}); sec = null; }
    if (!sec) continue;
    const m = {};
    for (const e of sec.entries) if (e.key) m[e.key] = e.value;
    items.push({ name: r.name, m: m, iniPath: full, from: idx.rel, remote: true });
    remoteReady.push(r.name);
  }
  const referenced = missingRefs().filter(x => x.kind === 'effect' && x.level !== 'info');
  if (!items.length && !referenced.length) {
    box.innerHTML = '';
    return;
  }
  const fxCount = items.filter(x => !x.unit).length;
  box.innerHTML =
    '<div class="fx-eff-head">贴图 / 特效预览 <span class="cnt">单位贴图 ' +
    (items.filter(x => x.unit).length ? '1 张' : '无') + '　·　特效 ' + (fxCount - remoteReady.length) + ' 个' +
    (remoteReady.length ? '　·　模组其它文件里找到 ' + remoteReady.length + ' 个' : '') +
    (referenced.length ? '　·　引用了但没定义 ' + referenced.length + ' 个' : '') + '</span></div>' +
    (items.length ? '<div class="fx-grid-eff" id="fxGridEff">' + items.map((it, i) => {
      const img = it.m.image;
      const frames = num(it.m.total_frames, 1);
      const fw = num(it.m.frame_width, 0), fh = num(it.m.frame_height, 0);
      const hasImg = img && !/^(NONE|AUTO)$/i.test(String(img).trim());
      const res = hasImg ? spriteOf(img, it.iniPath) : { kind: 'none' };
      const strip = it.m.stripIndex;
      const cls = !hasImg ? ' miss' : (res && res.kind === 'builtin' ? ' builtin' : (res && res.kind === 'missing' ? ' miss' : ''));
      const scaleTxt = (it.m.scaleFrom || it.m.scaleTo)
        ? '缩放 ' + (it.m.scaleFrom || '1') + ' → ' + (it.m.scaleTo || '1') : '';
      const kv = [
        it.m.life ? 'life ' + it.m.life + ' 帧' : '',
        frames > 1 ? frames + ' 帧' : '',
        scaleTxt,
        it.m.priority ? '优先 ' + it.m.priority : '',
        it.m.attachedToUnit === 'true' ? '跟随单位' : '',
      ].filter(Boolean).join('　');
      const bad = !hasImg ? (strip ? '使用内置贴图条 stripIndex：' + strip + '（无法预览）' : '未设置 image')
        : (res && res.kind === 'missing') ? '找不到贴图：' + img
        : (res && res.kind === 'builtin') ? '内置素材，无法预览'
        : (res && res.kind === 'loading' ? '解析中…' : '');
      return '<div class="eff-card' + cls + '" data-eff="' + i + '" title="点击放大预览">' +
        '<div class="ec-name">' + esc(it.name) + (it.remote ? ' <span class="au-tag loc">来自 ' +
          esc(String(it.from || '').split('\\').pop()) + '</span>' : '') + '</div>' +
        '<canvas class="ec-canvas" data-effcanvas="' + i + '" width="300" height="152"></canvas>' +
        '<div class="ec-kv"><em>' + esc(kv || '—') + '</em></div>' +
        (bad ? '<div class="ec-bad">' + esc(bad) + '</div>' : '') +
        '</div>';
    }).join('') + '</div>' : '') +
    (referenced.length ? '<div class="fx-grid-eff">' + referenced.map(r =>
      '<div class="eff-card miss"><div class="ec-name">' + esc(r.name) + '</div>' +
      '<canvas class="ec-canvas" width="300" height="152"></canvas>' +
      '<div class="ec-kv"><em>本文件（和模组）里没有 [effect_' + esc(r.name) + ']</em></div>' +
      '<div class="ec-bad">用在这里：' + esc(r.from.map(f => f.sec + '→' + f.key).join('、')) + '</div></div>').join('') + '</div>' : '');

  // 3) 逐帧动画：每张卡片一个画布
  ANIM.list = [];
  const t0 = performance.now();
  items.forEach((it, i) => {
    const cv = box.querySelector('[data-effcanvas="' + i + '"]');
    if (!cv) return;
    const img = it.m.image;
    const hasImg = img && !/^(NONE|AUTO)$/i.test(String(img).trim());
    if (!hasImg) return;
    const res = ASSET_REF_CACHE[(it.iniPath || S.doc.path || '') + '|' + img];
    if (res && res.kind === 'file') loadSprite(res.path);
    const frames = Math.max(1, num(it.m.total_frames, 1));
    const fw = num(it.m.frame_width, 0), fh = num(it.m.frame_height, 0);
    const life = num(it.m.life, 60) / 60 * 1000;        // 帧 → 毫秒
    const s0 = num(it.m.scaleFrom, 1), s1 = num(it.m.scaleTo, 1);
    const card = cv.closest('.eff-card');
    animAdd(t => {
      if (!card.isConnected) return;
      const e2 = ASSET_REF_CACHE[(it.iniPath || S.doc.path || '') + '|' + img];
      if (!e2 || e2.kind !== 'file') return;
      const sp = SPRITE_CACHE[e2.path];
      if (!sp || sp.state !== 'ok') return;
      const ctx = pixelCtx(cv);
      const W = cv.width, H = cv.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0b1016'; ctx.fillRect(0, 0, W, H);
      // 网格底纹，方便看大小
      ctx.strokeStyle = 'rgba(62,200,255,.08)'; ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 20) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
      const img2 = sp.img;
      // 严格按代码的帧分割数值切分（frame_width/frame_height/total_frames）
      const spec = frameSplitSpec(img2, it.m);
      // 按 life 把关键帧铺开：progress 0→1 对应 animateFrameStart→animateFrameEnd
      const prog = life > 0 ? ((t - t0) % life) / life : 0;
      const finfo = frameIdxAt(it.m, spec, prog);
      const sw = spec.fw, sh = spec.fh;
      const sx = (finfo.idx % spec.cols) * spec.fw;
      const sy = Math.floor(finfo.idx / spec.cols) * spec.fh;
      // 按 life 从 scaleFrom 渐变到 scaleTo（模拟游戏里的放大过程）
      const sc = s0 + (s1 - s0) * prog;
      const stripH = spec.count > 1 ? 22 : 0;
      const fit = Math.min((W - 18) / sw, (H - 18 - stripH) / sh);
      const w = sw * fit * Math.max(0.15, sc), h = sh * fit * Math.max(0.15, sc);
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.95;
      ctx.drawImage(img2, sx, sy, sw, sh, (W - w) / 2, (H - h) / 2, w, h);
      ctx.globalAlpha = 1;
      // 关键帧条
      if (stripH) drawFilmStrip(ctx, W, H, img2, spec, finfo.idx, H - stripH - 2);
      // 标注：帧尺寸 / 当前帧 / 缩放
      ctx.fillStyle = '#6b7d94'; ctx.font = '11px monospace';
      const frTxt = spec.count > 1
        ? Math.round(spec.fw) + '×' + Math.round(spec.fh) + '/帧　' +
          (finfo.lo !== 0 || finfo.hi !== spec.count - 1
            ? '帧 ' + finfo.idx + '（' + finfo.lo + '~' + finfo.hi + '）'
            : '帧 ' + finfo.idx + '/' + spec.count) +
          (finfo.pingPong ? ' 往返' : '')
        : Math.round(sw) + '×' + Math.round(sh) + 'px';
      ctx.fillText(frTxt, 6, H - 6 - stripH);
      ctx.fillStyle = '#ffb02e';
      ctx.fillText('×' + sc.toFixed(2), W - 52, H - 6 - stripH);
    });
  });
  animRun();

  box.onclick = ev => {
    const card = ev.target.closest('[data-eff]');
    if (!card) return;
    const it = items[parseInt(card.dataset.eff, 10)];
    if (it) openEffPreview(it);
  };
}

/** 点击特效卡片 → 放大逐帧预览 */
function openEffPreview(it) {
  const img = it.m.image;
  const frames = Math.max(1, num(it.m.total_frames, 1));
  const fw = num(it.m.frame_width, 0), fh = num(it.m.frame_height, 0);
  const res = img ? ASSET_REF_CACHE[(it.iniPath || S.doc.path || '') + '|' + img] : { kind: 'none' };
  if (img && !res) resolveRef(img, null, it.iniPath);
  const kv = [
    ['image', img || '（未设置）'],
    ['life', it.m.life ? it.m.life + ' 帧（' + round1(num(it.m.life) / 60) + ' 秒）' : '—'],
    ['帧数', frames > 1 ? frames + ' 帧' + (fw && fh ? '　' + fw + '×' + fh + '/帧' : '') : '单帧'],
    ['缩放', (it.m.scaleFrom || '1') + ' → ' + (it.m.scaleTo || '1')],
    ['优先级', it.m.priority || '—'],
    ['跟随单位', it.m.attachedToUnit === 'true' ? '是' : '否'],
  ];
  openModal('特效预览 · ' + it.name,
    '<div class="preview-box">' +
    '<canvas class="fx-modal-canvas" id="effBig" width="840" height="600"></canvas>' +
    '<div class="preview-kv">' + kv.map(x => '<span><b>' + esc(x[0]) + '</b> ' + esc(x[1]) + '</span>').join('') + '</div>' +
    (res && res.kind === 'file' ? '<div class="preview-kv"><span><b>贴图</b> ' + esc(res.path) + '</span></div>'
      : res && res.kind === 'missing' ? '<div class="preview-kv"><span style="color:var(--red)">找不到贴图文件 ' + esc(img) + '</span></div>'
      : res && res.kind === 'builtin' ? '<div class="preview-kv"><span>内置共享素材，无法预览</span></div>'
      : '<div class="preview-kv"><span>没有设置 image</span></div>') +
    '</div>', '<button class="btn" id="mClose">关闭</button>');
  $('#mClose').onclick = closeModal;
  if (!(res && res.kind === 'file')) return;
  const sp = loadSprite(res.path);
  const cv = $('#effBig');
  const life = num(it.m.life, 60) / 60 * 1000;
  const s0 = num(it.m.scaleFrom, 1), s1 = num(it.m.scaleTo, 1);
  const t0 = performance.now();
  const draw = t => {
    if (!cv.isConnected) return;
    if (sp.state !== 'ok') return;
    const ctx = pixelCtx(cv);
    const W = cv.width, H = cv.height;
    ctx.fillStyle = '#0b1016'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(62,200,255,.08)';
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    const img2 = sp.img;
    let sw = img2.width, sh = img2.height, sx = 0, sy = 0;
    if (frames > 1 && fw > 0 && fh > 0) {
      const perRow = Math.max(1, Math.floor(img2.width / fw));
      const idx = Math.floor((t - t0) / (1000 / 12)) % frames;
      sx = (idx % perRow) * fw; sy = Math.floor(idx / perRow) * fh; sw = fw; sh = fh;
    }
    const prog = life > 0 ? ((t - t0) % life) / life : 0;
    const sc = s0 + (s1 - s0) * prog;
    const fit = Math.min((W - 60) / sw, (H - 60) / sh);
    const w = sw * fit * Math.max(0.15, sc), h = sh * fit * Math.max(0.15, sc);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img2, sx, sy, sw, sh, (W - w) / 2, (H - h) / 2, w, h);
    ctx.fillStyle = '#6b7d94'; ctx.font = '16px monospace';
    ctx.fillText('原始 ' + Math.round(sw) + '×' + Math.round(sh) + 'px' + (frames > 1 ? '　' + frames + ' 帧' : ''), 14, H - 16);
    ctx.fillStyle = '#ffb02e';
    ctx.fillText('当前缩放 ×' + sc.toFixed(2) + '　缩放范围 ' + s0 + '→' + s1, 14, 26);
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

/* ============================================================
   15. 背包：把键 / 整段 存成可复用模块，一键追加到单位文件
   ============================================================ */
const BAG_KIND_TXT = { keys: '键模块', section: '整段' };

async function loadBag() {
  try {
    const d = await (await fetch('/api/backpack')).json();
    S.bag = d.items || [];
  } catch (e) { S.bag = []; }
  const badge = $('#bagBadge');
  badge.textContent = S.bag.length;
  badge.classList.toggle('zero', !S.bag.length);
}

async function saveBagItem(item) {
  const r = await fetch('/api/backpack/add', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item)
  });
  const d = await r.json();
  if (d.error) { toast('存进背包失败：' + esc(d.error), 'err'); return false; }
  await loadBag(); renderBag(); renderBagSelbar();
  return true;
}

async function deleteBagItem(id) {
  await fetch('/api/backpack/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id })
  });
  await loadBag(); renderBag();
}

/* ---- 勾选字段 ---- */
function pickId(sectionName, key) { return sectionName + '|' + key; }
function isPicked(sectionName, key) { return S.bagSel.some(p => p.id === pickId(sectionName, key)); }

function togglePick(sec, entry) {
  const id = pickId(sec.name, entry.key);
  const i = S.bagSel.findIndex(p => p.id === id);
  if (i >= 0) S.bagSel.splice(i, 1);
  else S.bagSel.push({ id: id, section: sec.name, key: entry.key, value: entry.value });
  renderBagSelbar(); renderEditor();
}

function renderBagSelbar() {
  const bar = $('#bagSelbar');
  if (!S.bagSel.length) {
    bar.className = 'bag-selbar';
    bar.innerHTML = '在中间编辑区点字段右侧的 <b>☆</b> 勾选要复用的键，或点段头 <b>❐</b> 把整段存成模块。' +
      '存好的模块可以在别的单位里一键追加，不用再复制粘贴。';
    return;
  }
  bar.className = 'bag-selbar on';
  bar.innerHTML =
    '<div class="sel-chips">' + S.bagSel.map(p =>
      '<span class="sel-chip" title="' + esc(p.section) + '">' + esc(p.key) + '</span>').join('') + '</div>' +
    '<input id="bagName" placeholder="模块名字（如 标准装甲、死亡爆炸）" value="' + esc(S.bagSel.length + ' 个键') + '">' +
    '<button class="btn primary small" id="bagSave">存进背包</button>' +
    '<button class="btn small ghost" id="bagClear">清空勾选</button>';
  $('#bagSave').onclick = async () => {
    const name = ($('#bagName').value || '').trim() || (S.bagSel.length + ' 个键');
    const item = {
      name: name, kind: 'keys', note: '',
      payload: S.bagSel.map(p => ({ section: deriveSecId(p.section), sectionName: p.section, key: p.key, value: p.value }))
    };
    if (await saveBagItem(item)) {
      S.bagSel = [];
      toast('已存进背包：<b>' + esc(name) + '</b>', 'ok');
      switchTab('bag');
    }
  };
  $('#bagClear').onclick = () => { S.bagSel = []; renderBagSelbar(); renderEditor(); };
}

/* ---- 整段存入背包 ---- */
async function packSection(sid) {
  const sec = S.doc.sections.find(s => s.id === sid);
  if (!sec) return;
  const name = String(sec.name).replace(/^\[|\]$/g, '');
  const item = {
    name: name, kind: 'section',
    note: '整段 ' + sec.entries.filter(e => e.kind === 'field').length + ' 个字段',
    payload: {
      name: name,
      comment: sec.comment || '',
      entries: sec.entries.filter(e => e.kind === 'field').map(e => ({ key: e.key, value: e.value, comment: e.comment || '' }))
    }
  };
  if (await saveBagItem(item)) toast('整段 <b>[' + esc(name) + ']</b> 已存进背包', 'ok');
}

/* ---- 应用背包模块到当前文件 ---- */
function applyBagItem(id) {
  const it = S.bag.find(x => x.id === id);
  if (!it) return;
  const ow = $('#bagOverwrite') && $('#bagOverwrite').checked;
  let added = 0, skipped = 0, sections = 0;

  if (it.kind === 'section' && it.payload && it.payload.entries) {
    let name = it.payload.name || it.name;
    // 段名冲突就自动加序号
    if (S.doc.sections.some(s => s.name === name)) {
      let i = 2;
      while (S.doc.sections.some(s => s.name === name + '_' + i)) i++;
      const old = name;
      name = name + '_' + i;
      toast('段名 <b>[' + esc(old) + ']</b> 已存在，新的存成 <b>[' + esc(name) + ']</b>', '', 3400);
    }
    const sec = newSection(name);
    sec.comment = it.payload.comment || '';
    sec.entries = it.payload.entries.map(e => newEntry(e.key, e.value, { comment: e.comment || '' }));
    S.doc.sections.push(sec);
    S.ui.activeSection = sec.id;
    added = sec.entries.length; sections = 1;
  } else if (it.payload) {
    for (const p of it.payload) {
      const secId = p.section || deriveSecId(p.sectionName || 'core');
      const sec = targetSection(secId);
      const exist = sec.entries.find(e => e.key === p.key);
      if (exist) {
        if (ow) { exist.value = p.value; added++; }
        else skipped++;
      } else {
        sec.entries.push(newEntry(p.key, p.value));
        added++;
      }
    }
  }
  markDirty(); renderAll(); switchTab('code');
  toast('已追加 <b>' + added + '</b> 个字段' + (sections ? '（' + sections + ' 段）' : '') +
    (skipped ? '，跳过 ' + skipped + ' 个已存在的键' : ''), 'ok', 3400);
}

/* ---- 背包列表 ---- */
function renderBag() {
  const box = $('#bagList');
  const q = ($('#bagSearch') ? $('#bagSearch').value : '').trim().toLowerCase();
  const items = S.bag.filter(it => !q || (it.name + ' ' + (it.note || '')).toLowerCase().includes(q));
  if (!S.bag.length) {
    box.innerHTML = '<div class="miss-ok">背包还是空的。<br>' +
      '在中栏勾选几个键（字段右侧 ☆）或整段（段头 ❐）存进来，<br>' +
      '以后在任何单位文件里都能一键追加，不用复制粘贴。</div>';
    return;
  }
  box.innerHTML = items.length ? items.map(it => {
    const isSec = it.kind === 'section';
    const keys = isSec ? (it.payload.entries || []).map(e => e.key) : (it.payload || []).map(p => p.key);
    return '<div class="bag-item' + (isSec ? ' k-section' : '') + '" data-bag="' + esc(it.id) + '">' +
      '<div class="bi-top"><span class="bi-name">' + esc(it.name) + '</span>' +
      '<span class="bi-kind">' + (BAG_KIND_TXT[it.kind] || '模块') + '</span>' +
      '<span class="bi-meta">' + (keys.length ? keys.length + ' 个键' : '') + (isSec ? ' · 整段' : '') + '</span></div>' +
      (it.note ? '<div class="bi-note">' + esc(it.note) + '</div>' : '') +
      '<div class="bi-keys">' + keys.slice(0, 14).map(k => '<span>' + esc(k) + '</span>').join('') +
      (keys.length > 14 ? '<span>…</span>' : '') + '</div>' +
      '<div class="bi-act">' +
      '<button class="btn primary small" data-bag-apply="' + esc(it.id) + '">＋ 追加到当前文件</button>' +
      '<button class="btn small" data-bag-note="' + esc(it.id) + '">改说明</button>' +
      '<button class="btn small ghost" data-bag-del="' + esc(it.id) + '">删除</button>' +
      '</div></div>';
  }).join('') : '<div class="miss-ok">没有匹配「' + esc(q) + '」的模块</div>';

  box.onclick = async ev => {
    const ap = ev.target.closest('[data-bag-apply]');
    if (ap) { applyBagItem(ap.dataset.bagApply); return; }
    const del = ev.target.closest('[data-bag-del]');
    if (del) {
      const it = S.bag.find(x => x.id === del.dataset.bagDel);
      if (it && confirm('从背包里删除「' + it.name + '」？（不会影响已经写进单位文件的内容）')) {
        await deleteBagItem(del.dataset.bagDel);
        toast('已删除', 'ok');
      }
      return;
    }
    const nt = ev.target.closest('[data-bag-note]');
    if (nt) {
      const it = S.bag.find(x => x.id === nt.dataset.bagNote);
      const v = prompt('给「' + it.name + '」写个说明：', it.note || '');
      if (v === null) return;
      await fetch('/api/backpack/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: it.id, note: v })
      });
      await loadBag(); renderBag();
    }
  };
}

/* ============================================================
   16. 缺失引用：代码里用了、但本文件（或模组）里没有的东西
   ============================================================ */
const BUILTIN_RES = ['credits', 'energy', 'hp', 'shield', 'ammo', 'setFlag', 'unsetFlag', 'hasFlag', 'hasMissingFlag'];
const MISS_KIND_TXT = { effect: '特效', action: '动作', unit: '单位', global: '全局变量', asset: '素材' };

function baseName(p) {
  // 去掉 CUSTOM: / ROOT: / SHADOW: / SHARED: 这类命名空间前缀，再取文件名
  return String(p).replace(/\\/g, '/').replace(/^(?:[A-Za-z_]+:)+/, '').split('/').pop();
}
function splitTop(v) {
  const out = []; let depth = 0, cur = '';
  for (const ch of String(v)) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}
function cleanRef(s) {
  return String(s).replace(/\([^)]*\)/g, '').replace(/\*\s*[\d.]+$/, '').replace(/^CUSTOM:/i, '').trim();
}

function localIndex() {
  const idx = { effect: {}, action: {}, unit: {}, global: {}, asset: {}, animation: {} };
  for (const s of S.doc.sections) {
    const id = deriveSecId(s.name);
    const nm = String(s.name).replace(/^\[|\]$/g, '');
    const kv = {};
    for (const e of s.entries) if (e.key) kv[e.key] = e.value;
    if (id === 'effect') idx.effect[nm.replace(/^effect_/i, '')] = nm;
    else if (id === 'action') idx.action[nm.replace(/^hiddenAction_/i, '').replace(/^action_/i, '')] = nm;
    else if (id === 'global_resource' || id === 'resource') idx.global[nm.replace(/^global_resource_/i, '').replace(/^resource_/i, '')] = nm;
    else if (id === 'animation') idx.animation[nm.replace(/^animation_/i, '')] = nm;
    if (id === 'core' && kv.name) idx.unit[kv.name] = S.doc.name;
    for (const e of s.entries) {
      if (!e.key) continue;
      if (/image|icon|sound|音频|图片/i.test(e.key) && /\.(png|jpg|jpeg|bmp|gif|ogg|wav|mp3)$/i.test(String(e.value).trim()))
        idx.asset[baseName(e.value).toLowerCase()] = e.key;
    }
  }
  return idx;
}

function builtinEnums() {
  const g = (k) => (S.meta.enums[k] || { items: [] }).items.map(i => i.v);
  return {
    effect: g('explosionEffect'),
    asset: g('builtinImage').concat(g('builtinSound')).map(x => baseName(x).toLowerCase()),
  };
}

function missCacheKey() {
  const n = S.doc.sections.length;
  const m = S.doc.sections.reduce((a, x) => a + x.entries.length, 0);
  const sc = (S.scan && S.scan.ok) ? (S.scan.root + '#' + S.scan.seconds) : 'noscan';
  return sc + '|' + n + '|' + m + '|' + (S.doc.rev || 0);
}
function missingRefs() {
  const key = missCacheKey();
  if (S.ui._miss && S.ui._missKey === key) return S.ui._miss;
  const idx = localIndex();
  const bidx = builtinEnums();
  const scan = S.scan;
  const scanSets = scan && scan.ok ? {
    effect: new Set((scan.effects || []).map(x => x.name)),
    action: new Set((scan.actions || []).map(x => x.name)),
    unit: new Set((scan.units || []).map(x => x.name)),
    global: new Set((scan.globals || []).map(x => x.name)),
    asset: new Set((scan.assets ? [] : [])),
  } : null;
  const scanAssets = new Set();
  if (scan && scan.ok && scan.assets) {
    for (const a of scan.assets.index || []) scanAssets.add(String(a).toLowerCase());
  }
  const out = [];
  const seen = {};
  const push = (kind, name, sec, key, value) => {
    if (!name) return;
    const id = kind + '|' + name;
    if (seen[id]) { if (seen[id].from.length < 4) seen[id].from.push({ sec: sec, key: key }); return; }
    // 本地是否有定义
    if (idx[kind] && idx[kind][name]) return;
    if (kind === 'asset' && (bidx.asset.includes(String(name).toLowerCase()) || scanAssets.has(String(name).toLowerCase()))) return;
    if (kind === 'effect' && bidx.effect.includes(name)) return;
    let level = 'info', why = '本文件里没有定义（没有扫描模组，无法确认别处有没有）';
    if (scan && scan.ok) {
      const has = scanSets[kind] ? scanSets[kind].has(name) : false;
      if (has) { level = 'info'; why = '本文件里没有，但模组其它文件里有'; }
      else { level = 'warn'; why = '本文件里没有，整个模组里也没找到'; }
    }
    const rec = { kind: kind, name: name, level: level, why: why, from: [{ sec: sec, key: key }], value: value };
    seen[id] = rec;
    out.push(rec);
  };

  for (const s of S.doc.sections) {
    const id = deriveSecId(s.name);
    const nm = String(s.name).replace(/^\[|\]$/g, '');
    for (const e of s.entries) {
      if (e.kind !== 'field') continue;
      const k = e.key, v = String(e.value || '').trim();
      if (!v) continue;
      // 特效
      if (/effect/i.test(k) && !/Rate|Multiplier/i.test(k)) {
        for (const part of splitTop(v)) {
          const c = cleanRef(part);
          if (/^[A-Za-z_][\w.]*$/.test(part.trim()) && !/^CUSTOM:/i.test(part.trim())) continue;   // 内置爆炸效果名
          if (c && !/^[\d.]+$/.test(c)) push('effect', c, nm, k, v);
        }
      }
      // 动作
      if (['alsoTriggerAction', 'alsoQueueAction', 'whenBuilding_triggerAction', 'onShoot_triggerActions',
           'fireTurretXAtGround', 'fireTurretXAtSelf', 'onActions'].includes(k)) {
        for (const part of splitTop(v)) {
          const c = cleanRef(part);
          if (!c || /^[\d.]+$/.test(c) || looksLikeExpr(c)) continue;
          push('action', c, nm, k, v);
        }
      }
      // 单位
      if (['unitsSpawnedOnDeath', 'spawnUnit', 'addUnitsIntoTransport', 'convertTo',
           'whenBuilding_temporarilyConvertTo', 'builderUnits'].includes(k) ||
          (k === 'name' && id === 'canBuild')) {
        for (const part of splitTop(v)) {
          const c = cleanRef(part);
          if (!c || /^[\d.]+$/.test(c) || /\$|\{/.test(c)) continue;
          if (/^(true|false)$/i.test(c)) continue;
          push('unit', c, nm, k, v);
        }
      }
      // 全局变量（资源）
      if (['addResources', 'price', 'resourceUsage', 'generation_resources', 'setResourcesWithLogic',
           'borrowResourcesWhileAlive', 'borrowResourcesWhileBuilt', 'resourcesNeededToStart'].includes(k)) {
        for (const part of splitTop(v)) {
          const m = part.match(/^([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)\s*=/);
          if (!m) continue;
          const name = m[1];
          if (BUILTIN_RES.includes(name)) continue;
          push('global', name, nm, k, v);
        }
      }
      // 素材
      if (/^(image|image_.*|.*_image|iconImage|.*Icon.*|.*_sound|sound.*)$/i.test(k)) {
        const b = baseName(v);
        if (b && /\.(png|jpg|jpeg|bmp|gif|ogg|wav|mp3)$/i.test(b) && !/^(AUTO|NONE)$/i.test(b)) push('asset', b, nm, k, v);
      }
    }
  }
  const order = { warn: 0, info: 1 };
  out.sort((a, b) => order[a.level] - order[b.level] || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  S.ui._miss = out;
  S.ui._missKey = key;
  return out;
}

function bagMatchFor(kind, name) {
  if (kind === 'asset') return null;
  return S.bag.find(it => {
    if (it.kind !== 'section') return false;
    const n = String((it.payload && it.payload.name) || it.name).replace(/^\[|\]$/g, '');
    const bare = n.replace(/^effect_/i, '').replace(/^hiddenAction_/i, '').replace(/^action_/i, '')
      .replace(/^global_resource_/i, '').replace(/^resource_/i, '');
    return bare === name;
  }) || null;
}

function stubSection(kind, name) {
  const spec = {
    effect: ['effect_' + name, [['life', '60'], ['image', name + '.png'], ['total_frames', '1'], ['scaleFrom', '1'], ['scaleTo', '1']]],
    action: ['action_' + name, [['text', name], ['description', ''], ['displayType', 'action'], ['isVisible', 'true'], ['buildSpeed', '0s'], ['pos', '0']]],
    global: ['global_resource_' + name, [['displayName', name], ['displayNameShort', name], ['displayColor', '#FF9D00FF'], ['hidden', 'false'], ['priority', '1']]],
    animation: ['animation_' + name, [['onActions', 'true'], ['playbackRate', '1']]],
  }[kind];
  if (!spec) return null;
  const sec = newSection(spec[0]);
  sec.entries = spec[1].map(([k, v]) => newEntry(k, v));
  return sec;
}

function renderBagMiss() {
  const box = $('#bagMiss');
  const list = missingRefs();
  const badge = $('#missBadge');
  const bad = list.filter(x => x.level === 'warn').length;
  badge.textContent = bad;
  badge.classList.toggle('zero', !bad);
  const scanning = S.ui.scanning;
  $('#missHint').textContent = S.scan && S.scan.ok
    ? '已扫描模组：' + S.scan.root + '（' + S.scan.files + ' 个 ini/template）'
    : '代码里引用了、但本文件里没有的 特效 / 动作 / 单位 / 全局变量 / 素材（勾选上面的「扫描整个模组」可判断是否在别的文件里）';

  if (!list.length) {
    box.innerHTML = '<div class="miss-ok">✓ 没有发现悬空引用</div>';
    return;
  }
  box.innerHTML = list.map((m, i) => {
    const bm = bagMatchFor(m.kind, m.name);
    const canStub = ['effect', 'action', 'global'].includes(m.kind);
    return '<div class="miss-card' + (m.level === 'info' ? ' soft' : '') + '" data-miss="' + i + '">' +
      '<div class="mc-top"><span class="mc-kind">' + (MISS_KIND_TXT[m.kind] || m.kind) + '</span>' +
      '<span class="mc-name">' + esc(m.name) + '</span>' +
      '<span class="bi-meta">' + esc(m.why) + '</span></div>' +
      '<div class="mc-from">用在这里：' + m.from.map(f => esc(f.sec) + ' → ' + esc(f.key)).join('　·　') + '</div>' +
      '<div class="mc-act">' +
      (bm ? '<button class="btn small primary" data-miss-bag="' + i + '">从背包补全（' + esc(bm.name) + '）</button>' : '') +
      (canStub ? '<button class="btn small" data-miss-stub="' + i + '">＋ 建一个空段</button>' : '') +
      (canStub ? '<button class="btn small ghost" data-miss-stub-pack="' + i + '">建段并存入背包</button>' : '') +
      (m.kind === 'unit' ? '<button class="btn small" data-miss-find="' + i + '">在模组里找</button>' : '') +
      (m.kind === 'asset' ? '<button class="btn small" data-miss-copy="' + i + '">复制文件名</button>' : '') +
      '<button class="btn small ghost" data-miss-goto="' + i + '">定位</button>' +
      '</div></div>';
  }).join('');

  box.onclick = async ev => {
    const t = ev.target.closest('button');
    if (!t) return;
    const i = parseInt(t.dataset.missBag || t.dataset.missStub || t.dataset.missStubPack ||
      t.dataset.missFind || t.dataset.missCopy || t.dataset.missGoto, 10);
    const m = list[i];
    if (!m) return;
    if (t.dataset.missBag) {
      const bm = bagMatchFor(m.kind, m.name);
      if (bm) { applyBagItem(bm.id); toast('已从背包补全 <b>' + esc(m.name) + '</b>', 'ok'); }
      return;
    }
    if (t.dataset.missStub || t.dataset.missStubPack) {
      const sec = stubSection(m.kind, m.name);
      if (!sec) return;
      S.doc.sections.push(sec);
      S.ui.activeSection = sec.id;
      markDirty(); renderAll();
      toast('已新建 <b>[' + esc(sec.name) + ']</b>，字段可以照着代码表改', 'ok', 3600);
      if (t.dataset.missStubPack) {
        await saveBagItem({
          name: sec.name, kind: 'section', note: '由缺失引用补全生成',
          payload: { name: sec.name, comment: '', entries: sec.entries.map(e => ({ key: e.key, value: e.value, comment: '' })) }
        });
        toast('同时已存入背包，以后可以直接复用', 'ok', 3600);
      }
      return;
    }
    if (t.dataset.missFind) {
      toast('正在模组里搜索 <b>' + esc(m.name) + '</b>…', '', 2200);
      try {
        const d = await (await fetch('/api/search?q=' + encodeURIComponent(m.name) +
          '&root=' + encodeURIComponent(S.modRoot || ''))).json();
        if (!d.hits || !d.hits.length) toast('模组里没有找到包含「' + esc(m.name) + '」的文件', '', 3600);
        else toast('找到 ' + d.hits.length + ' 个文件：<br>' + d.hits.slice(0, 3).map(h => esc(h.dir) + '\\' + esc(h.name)).join('<br>'), '', 6000);
      } catch (e) { toast('搜索失败', 'err'); }
      return;
    }
    if (t.dataset.missCopy) {
      navigator.clipboard.writeText(m.name).then(() => toast('已复制文件名：' + esc(m.name), 'ok'), () => {});
      return;
    }
    if (t.dataset.missGoto) {
      const f = m.from[0];
      if (isMobile()) switchMobileView('edit');
      const sec = S.doc.sections.find(s => s.name === f.sec);
      if (sec) { sec.collapsed = false; renderEditor(); switchTab('code'); focusField(deriveSecId(sec.name), f.key); }
      return;
    }
  };
}

/** 启动后台扫描：不阻塞界面，扫完刷新一次 */
let _scanJob = null;
/** 串行化扫描：前一个扫完再扫，避免换文件时被顶掉 */
async function runScan(root, force) {
  if (_scanJob) { try { await _scanJob.promise; } catch (e) {} }
  const p = ensureScan(force, root);
  _scanJob = { promise: p };
  try { return await p; } finally { if (_scanJob && _scanJob.promise === p) _scanJob = null; }
}

let _bgScanTimer = 0;
function scheduleBackgroundScan(delay) {
  if (_bgScanTimer) clearTimeout(_bgScanTimer);
  _bgScanTimer = setTimeout(() => {
    _bgScanTimer = 0;
    if ('requestIdleCallback' in window) requestIdleCallback(() => backgroundScan(), { timeout: 3000 });
    else backgroundScan();
  }, Math.max(200, delay || 900));
}

async function backgroundScan() {
  if (S.ui.scanning) return;
  // 优先用当前文件所在目录（服务器会自动往上找到真正的模组根）
  const docDir = S.doc.path ? S.doc.path.replace(/[/\\][^/\\]*$/, '') : '';
  const root = docDir || S.fs.modRoot || S.fs.path || S.modRoot || '';
  if (!root) return;
  const norm = p => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  const nr = norm(root), sr = norm(S.scan && S.scan.root);
  const sameMod = !!(S.scan && S.scan.ok && sr && (nr.startsWith(sr) || sr.startsWith(nr)));
  const st = $('#stMeta');
  const old = st ? st.textContent : '';
  if (st) st.textContent = '正在后台扫描模组（识别全局变量、素材引用与重复键）…';
  // 同一个模组优先用已有扫描结果；只有换模组/首次才强制重扫，避免每次开文件都卡几十秒
  const d = await runScan(root, !sameMod);
  if (st) st.textContent = old;
  if (d && d.ok) {
    S.ui._miss = null;
    renderPreviewAll();
    if ($('#sideFs') && !$('#sideFs').classList.contains('hidden')) renderFs();
  }
}

const ensureScan = async (force, rootArg) => {
  if (!force && S.scan && S.scan.ok && !S.scan.cached) return S.scan;
  S.ui.scanning = true;
  try {
    const url = '/api/mod/scan?root=' + encodeURIComponent(rootArg || S.modRoot || '') + (force ? '&refresh=1' : '');
    S.scan = await (await fetch(url)).json();
  } catch (e) { S.scan = null; }
  S.ui.scanning = false;
  S.ui._miss = null;
  return S.scan;
};

/* ============================================================
   17. 模组体检：素材引用 / 全局变量 / all-units
   ============================================================ */
async function openAuditModal(tab) {
  const html =
    '<div class="audit-root">' +
    '<input id="auRoot" value="' + esc(S.modRoot || '') + '" placeholder="模组根目录，例如 D:\\RTmod\\wcmod operation 遗骸与血统0.4a">' +
    '<button class="btn" id="auScan">扫描</button>' +
    '<button class="btn ghost" id="auForce">重新扫描</button></div>' +
    '<div class="audit-tabs">' +
    '<button data-atab="assets" class="active">素材引用</button>' +
    '<button data-atab="globals">全局变量</button>' +
    '<button data-atab="allunits">all-units 模板</button>' +
    '<button data-atab="dups">重复键 <span class="badge hidden" id="auDupBadge">0</span></button></div>' +
    '<div id="auInfo" class="hint" style="text-align:left;margin-bottom:8px"></div>' +
    '<div id="auBody"><div class="miss-ok">正在扫描模组…（大模组需要几秒）</div></div>';
  openModal('模组体检', html, '<button class="btn" id="mClose">关闭</button>');
  $('#mClose').onclick = closeModal;
  S.ui.auditTab = tab || S.ui.auditTab || 'assets';
  const drawTabs = () => $$('.audit-tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.atab === S.ui.auditTab));
  $$('.audit-tabs button').forEach(b => b.onclick = () => { S.ui.auditTab = b.dataset.atab; drawTabs(); renderAudit(); });
  drawTabs();

  const doScan = async (force) => {
    $('#auInfo').textContent = '扫描中…';
    const d = await ensureScan(force);
    if (!d || d.error) { $('#auInfo').textContent = '扫描失败：' + ((d && d.error) || '网络错误'); return; }
    const dq = d.duplicates || {};
    const db = $('#auDupBadge');
    if (db) {
      db.textContent = dq.fileCount || 0;
      db.classList.toggle('hidden', !dq.fileCount);
    }
    $('#auInfo').textContent = (d.cached ? '（用了缓存结果）' : '扫描完成：') +
      d.files + ' 个 ini/template，耗时 ' + d.seconds + ' 秒' +
      (dq.fileCount ? ' · 重复键文件 ' + dq.fileCount + ' 个 / ' + (dq.keyCount || 0) + ' 处' : '') +
      (d.truncated ? '（太大，只扫描了一部分）' : '');
    renderAudit();
    if ($('#sideFs') && !$('#sideFs').classList.contains('hidden')) renderFs();
  };
  $('#auScan').onclick = async () => {
    S.modRoot = $('#auRoot').value.trim();
    fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modRoot: S.modRoot }) }).catch(() => {});
    S.scan = null;
    await doScan(true);
  };
  $('#auForce').onclick = () => doScan(true);
  await doScan(false);
}

function renderAudit() {
  const d = S.scan;
  const body = $('#auBody');
  if (!d || !d.ok) { body.innerHTML = '<div class="miss-ok">还没有扫描结果</div>'; return; }
  if (S.ui.auditTab === 'globals') return renderAuditGlobals(d);
  if (S.ui.auditTab === 'allunits') return renderAuditAllUnits(d);
  if (S.ui.auditTab === 'dups') return renderAuditDups(d);
  return renderAuditAssets(d);
}

function renderAuditDups(d) {
  const q = d.duplicates || {};
  const files = q.files || [];
  const groups = q.groups || [];
  const byFile = new Map();
  for (const g of groups) {
    if (!byFile.has(g.path)) byFile.set(g.path, []);
    byFile.get(g.path).push(g);
  }
  let html = '<div class="audit-cards">' +
    acard('含重复键文件', q.fileCount || 0, '个', q.fileCount ? 'bad' : 'ok') +
    acard('重复键组', q.groupCount || 0, '组', q.groupCount ? 'bad' : 'ok') +
    acard('多余键', q.keyCount || 0, '处', q.keyCount ? 'bad' : 'ok') +
    acard('值相同的重复', q.sameCount || 0, '组', q.sameCount ? 'warn' : '') +
    '</div>' +
    '<div class="hint" style="text-align:left;margin-bottom:10px">' +
    '只检查 <b>.ini / .template</b> 中同一段内的重复键，键名不区分大小写；不同段里的同名键不算重复。' +
    '「多余键」= 重复出现的键多出来的次数。点「打开」会关闭体检并载入该文件。</div>';
  if (!files.length) {
    html += '<div class="miss-ok">没有发现段内重复键 ✓</div>';
    $('#auBody').innerHTML = html;
    return;
  }
  html += '<div class="dup-files">';
  files.forEach((f, i) => {
    const gs = byFile.get(f.path) || [];
    html += '<details class="dup-file"' + (i === 0 ? ' open' : '') + '>' +
      '<summary><span class="dup-warn">⚠</span>' +
      '<span class="dup-name">' + esc(f.name) + '</span>' +
      '<span class="au-tag bad">' + (f.groups || 0) + ' 组</span>' +
      '<span class="au-tag">' + (f.keys || 0) + ' 处</span>' +
      '<span class="dup-rel" title="' + esc(f.rel) + '">' + esc(f.rel) + '</span></summary>' +
      '<div class="dup-groups">';
    if (!gs.length) {
      html += '<div class="hint" style="text-align:left">这个文件的详细条目超过显示上限，未展开。</div>';
    } else {
      gs.forEach(g => {
        const vals = (g.values || []).map(v => esc(v) || '<em>(空)</em>').join(' <span class="dup-slash">/</span> ') +
          (g.count > (g.values || []).length ? ' <span class="dup-slash">…</span>' : '');
        html += '<div class="dup-group">' +
          '<span class="dup-sec">[' + esc(g.section) + ']' + (g.occ ? ' #' + (g.occ + 1) : '') + '</span>' +
          '<span class="dup-key">' + esc(g.key) + '</span>' +
          '<span class="au-tag ' + (g.same ? 'ok' : 'bad') + '">' + (g.same ? '值相同' : '值不同') + '</span>' +
          '<span class="dup-count">×' + g.count + '</span>' +
          '<span class="dup-lines">行 ' + ((g.lines || []).join(', ')) +
            (g.count > (g.lines || []).length ? ' …' : '') + '</span>' +
          '<span class="dup-vals">' + (vals || '<em>(空)</em>') + '</span>' +
          '<button class="btn small ghost" data-auopen="' + esc(g.path) + '">打开</button>' +
          '</div>';
      });
    }
    html += '</div></details>';
  });
  html += '</div>';
  if (q.truncated) html += '<div class="hint" style="text-align:left">条目太多，只显示了前 ' + groups.length + ' 组；文件统计仍是完整的。</div>';
  $('#auBody').innerHTML = html;
  $('#auBody').onclick = ev => {
    const b = ev.target.closest('[data-auopen]');
    if (b) { closeModal(); fsOpenInEditor(b.dataset.auopen); }
  };
}

function renderAuditAssets(d) {
  const a = d.assets || {};
  const mb = (a.unusedBytes || 0) / 1024 / 1024;
  let html =
    '<div class="audit-cards">' +
    acard('素材文件', a.total || 0, '个', '') +
    acard('未被引用', a.unusedCount || 0, '个', (a.unusedCount ? 'warn' : 'ok')) +
    acard('未引用体积', mb.toFixed(1), 'MB', (mb > 1 ? 'warn' : '')) +
    acard('引用了但找不到', a.missingCount || 0, '个', (a.missingCount ? 'bad' : 'ok')) +
    acard('ini / template', d.files || 0, '个', '') +
    '</div>' +
    '<div class="hint" style="text-align:left;margin-bottom:8px">' +
    '「未被引用」= 在所有 ini / template 文本里都没出现过文件名（只按文件名匹配，地图、脚本、外部工具里的引用不参与判断）。' +
    '点击名字可复制路径。</div>';
  html += '<div class="bag-sec-title">未被引用的素材（按体积从大到小）</div><div class="audit-list" id="auUnused">' +
    ((a.unused || []).length ? a.unused.map(u =>
      '<div class="aurow" data-copy="' + esc(u.rel) + '"><span class="an">' + esc(u.name) + '</span>' +
      '<span class="ap">' + esc(u.rel) + '</span>' +
      '<span class="as">' + fmtSize(u.size) + '</span></div>').join('')
      : '<div class="miss-ok">没有未被引用的素材 ✓</div>') + '</div>';
  html += '<div class="bag-sec-title" style="margin-top:12px">代码里引用了、但模组里找不到文件的素材</div>' +
    '<div class="audit-list" id="auMissing">' +
    ((a.missing || []).length ? a.missing.map(m =>
      '<div class="aurow" data-copy="' + esc(m.name) + '"><span class="an">' + esc(m.name) + '</span>' +
      '<span class="as" style="color:var(--red)">缺文件</span></div>').join('')
      : '<div class="miss-ok">没有缺失的素材文件 ✓</div>') + '</div>';
  $('#auBody').innerHTML = html;
  $('#auBody').onclick = ev => {
    const r = ev.target.closest('[data-copy]');
    if (r) navigator.clipboard.writeText(r.dataset.copy).then(() => toast('已复制：' + esc(r.dataset.copy), 'ok'), () => {});
  };
}

function acard(k, v, unit, cls) {
  return '<div class="acard ' + (cls || '') + '"><div class="ak">' + esc(k) + '</div>' +
    '<div class="av">' + esc(v) + (unit ? ' <span style="font-size:11px;color:var(--txt3);font-family:var(--ui)">' +
      esc(unit) + '</span>' : '') + '</div></div>';
}

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function renderAuditGlobals(d) {
  const gs = d.globals || [];
  const ghosts = d.ghostGlobals || [];
  let html =
    '<div class="audit-cards">' +
    acard('全局资源 / 变量', (d.counts && d.counts.globals) || gs.length, '个', 'ok') +
    acard('被使用但没定义', ghosts.length, '个', ghosts.length ? 'bad' : 'ok') +
    acard('特效（模组内）', (d.counts && d.counts.effects) || 0, '个', '') +
    acard('动作（模组内）', (d.counts && d.counts.actions) || 0, '个', '') +
    acard('单位（模组内）', (d.counts && d.counts.units) || 0, '个', '') +
    '</div>';
  if (ghosts.length) {
    html += '<div class="bag-sec-title" style="color:var(--red)">⚠ 被引用但从没定义过的全局变量（写 addResources / price 时会用到它们）</div>' +
      '<div class="audit-list" style="margin-bottom:12px">' + ghosts.map(g =>
        '<div class="aurow"><span class="an">' + esc(g.name) + '</span>' +
        '<span class="as">被用了 ' + g.uses + ' 次</span></div>').join('') + '</div>';
  }
  html += '<div class="bag-sec-title">全部全局资源 / 变量（' + gs.length + ' 个）</div>' +
    '<table class="res-tbl"><tr><th>变量名</th><th>显示名</th><th>颜色</th><th>类型</th><th>来源文件</th></tr>' +
    gs.map(g => '<tr><td class="k">' + esc(g.name) + '</td>' +
      '<td class="d">' + esc(g.displayName || g.displayNameShort || '') + '</td>' +
      '<td>' + (g.displayColor ? '<span class="swatch" style="background:' + esc(g.displayColor) + '"></span> <span class="k" style="font-size:11px">' + esc(g.displayColor) + '</span>' : '') + '</td>' +
      '<td><span class="au-tag ' + (g.global ? 'glob' : 'loc') + '">' + (g.global ? '全局' : '局部') + '</span>' +
      (g.hidden === 'true' ? ' <span class="au-tag">隐藏</span>' : '') + '</td>' +
      '<td class="d" style="font-size:11px">' + esc(g.rel || '') + '</td></tr>').join('') +
    '</table>';
  $('#auBody').innerHTML = html;
}

function renderAuditAllUnits(d) {
  const au = d.allUnits;
  if (!au) {
    $('#auBody').innerHTML = '<div class="miss-ok">这个目录里没有找到 <b>all-units.template</b>。<br>' +
      '它是模组的全局模板：放在模组根目录，里面写的键会应用到模组内所有单位。' +
      (d.suggestRoot ? '<br><br>当前扫的是子文件夹，整个模组的根应该是：<br><b>' + esc(d.suggestRoot) + '</b>' +
        '<br><button class="btn primary small" id="auUseSuggest" style="margin-top:8px">改用这个目录重新扫描</button>' : '') +
      '</div>';
    const b = $('#auUseSuggest');
    if (b) b.onclick = async () => {
      S.modRoot = d.suggestRoot; $('#auRoot').value = d.suggestRoot;
      S.scan = null;
      const nd = await ensureScan(true);
      if (nd && nd.ok) { $('#auInfo').textContent = '扫描完成：' + nd.files + ' 个文件'; renderAudit(); }
    };
    return;
  }
  const byName = {};
  for (const s of au.sections) byName[s.name] = s;
  const core = byName['core'];
  const res = au.sections.filter(s => /^(global_resource_|resource_)/i.test(s.name));
  const tpl = au.sections.filter(s => /^template_/i.test(s.name));
  const others = au.sections.filter(s => !/^(global_resource_|resource_|template_)/i.test(s.name) && s.name !== 'core');

  const chip = (k, v) => {
    const fm = fieldMeta('core', k) || (findKeyMeta(k) || [])[0] && (findKeyMeta(k) || [])[0].entry;
    const cn = fm ? (fm.trans || '') : '';
    return '<span class="kv-chip"><b>' + esc(k) + '</b><i>' + esc(String(v).slice(0, 40)) + '</i>' +
      (cn ? '<span class="cn">' + esc(cn) + '</span>' : '') + '</span>';
  };

  let html = '<div class="su-hero"><div class="h1">全模组默认设置（all-units.template）</div>' +
    '<div class="h2">' + esc(au.path) + '</div>' +
    '<div class="hint" style="text-align:left;margin-top:6px">共 ' + au.sections.length + ' 段 · ' +
    au.lines + ' 行。这里写的键会应用到这个模组里的每一个单位（单位自己在 ini 里写的同名字段会覆盖它）。</div>' +
    '<div style="margin-top:9px;display:flex;gap:7px;flex-wrap:wrap">' +
    '<button class="btn primary small" id="auOpenAll">在编辑器里打开它</button>' +
    '<button class="btn small" id="auCopyAll">复制路径</button></div></div>';

  html += '<div class="su-sec"><h4>[core] 全局默认键 <span class="cnt">' +
    ((core && core.keys.length) || 0) + ' 个</span></h4>' +
    (core && core.keys.length ? '<div class="kv-chips">' +
      core.keys.map(x => chip(x.k, x.v)).join('') + '</div>'
      : '<div class="hint" style="text-align:left">没有 [core] 段</div>') + '</div>';

  html += '<div class="su-sec"><h4>全局资源 / 变量 <span class="cnt">' + res.length + ' 个</span></h4>' +
    (res.length ? '<div class="res-chips">' + res.map(s => {
      const kv = {}; s.keys.forEach(x => kv[x.k] = x.v);
      const col = kv.displayColor || '';
      return '<span class="res-chip">' +
        (col ? '<span class="swatch" style="background:' + esc(col) + '"></span>' : '') +
        '<span class="nm">' + esc(s.name.replace(/^(global_resource_|resource_)/i, '')) + '</span>' +
        '<span class="dn">' + esc(kv.displayName || '') + '</span>' +
        (kv.hidden === 'true' ? '<span class="hd">隐藏</span>' : '') +
        (kv.iconImage ? '<span class="hd" title="' + esc(kv.iconImage) + '">有图标</span>' : '') +
        '</span>';
    }).join('') + '</div>' : '<div class="hint" style="text-align:left">没有定义全局资源</div>') + '</div>';

  html += '<div class="su-sec"><h4>模板段 [template_*] <span class="cnt">' + tpl.length + ' 个</span></h4>' +
    (tpl.length ? '<div class="kv-chips">' + tpl.map(s =>
      '<span class="kv-chip"><b>' + esc(s.name) + '</b><i>' + s.keys.length + ' 个键</i></span>').join('') + '</div>'
      : '<div class="hint" style="text-align:left">没有模板段</div>') + '</div>';

  if (others.length) {
    html += '<div class="su-sec"><h4>其它段 <span class="cnt">' + others.length + ' 个</span></h4><div class="kv-chips">' +
      others.map(s => '<span class="kv-chip"><b>[' + esc(s.name) + ']</b><i>' + s.keys.length + ' 个键</i></span>').join('') +
      '</div></div>';
  }
  $('#auBody').innerHTML = html;
  $('#auOpenAll').onclick = async () => {
    const r = await (await fetch('/api/file/load?path=' + encodeURIComponent(au.path))).json();
    if (r.error || r.text == null) { toast(r.error || '读不到文件内容', 'err'); return; }
    S.doc.sections = parseIni(r.text);
    S.doc.path = r.path; S.doc.name = r.name; markDirty(false);
    S.ui.activeSection = S.doc.sections[0] ? S.doc.sections[0].id : null;
    closeModal(); renderAll(); switchTab('effect');
    toast('已在编辑器里打开 <b>' + esc(r.name) + '</b>', 'ok');
  };
  $('#auCopyAll').onclick = () => navigator.clipboard.writeText(au.path).then(() => toast('已复制路径', 'ok'), () => {});
}


/* ============================================================
   19. 移动端 / 触屏适配
   ============================================================ */
function isMobile() { return window.matchMedia('(max-width: 820px)').matches; }
function isTouch() {
  return window.matchMedia('(hover: none)').matches || ('ontouchstart' in window) ||
    window.matchMedia('(max-width: 820px)').matches;
}

/** 底部导航：代码库 / 编辑 / 预览 / 资源 */
function switchMobileView(name) {
  S.ui.mview = name;
  $$('.mobnav-btn').forEach(b => b.classList.toggle('active', b.dataset.mv === name));
  const left = $('#leftPanel'), mid = document.querySelector('.panel.mid'), right = document.querySelector('.panel.right');
  $$('.panel').forEach(p => p.classList.remove('mob-on'));
  if (name === 'lib') { left.classList.add('mob-on'); switchSide('lib'); }
  else if (name === 'fs') { left.classList.add('mob-on'); switchSide('fs'); }
  else if (name === 'edit') { mid.classList.add('mob-on'); }
  else if (name === 'view') { right.classList.add('mob-on'); }
  const host = document.scrollingElement;
  if (host) host.scrollTop = 0;
}

function toggleMenu(force) {
  const bar = document.querySelector('.topbar');
  const on = force != null ? force : !bar.classList.contains('menu-open');
  bar.classList.toggle('menu-open', on);
}

function setupSafeArea() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;bottom:0;height:0;padding-bottom:env(safe-area-inset-bottom);';
  document.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height || 0;
  probe.remove();
  if (px > 0) document.documentElement.style.setProperty('--safe-b', px + 'px');
}

/** 画布按元素实际大小渲染，手机上文字才不会糊成一团 */
function fitCanvas(cv, ratio) {
  const w = Math.max(280, Math.round(cv.clientWidth || 360));
  const h = Math.round(w / (ratio || 1.7));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.height = h + 'px';
  const ctx = pixelCtx(cv);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { W: w, H: h, ctx: ctx };
}

function bindMobile() {
  $$('.mobnav-btn').forEach(b => b.onclick = () => switchMobileView(b.dataset.mv));
  const mb = $('#btnMenu');
  if (mb) mb.onclick = ev => { ev.stopPropagation(); toggleMenu(); };
  // 点了工具栏里的按钮就收起菜单
  document.querySelector('.toolbar').addEventListener('click', ev => {
    if (ev.target.closest('button') && isMobile()) toggleMenu(false);
  });
  document.addEventListener('click', ev => {
    const bar = document.querySelector('.topbar');
    if (!bar.classList.contains('menu-open')) return;
    if (!ev.target.closest('.toolbar') && !ev.target.closest('#btnMenu')) toggleMenu(false);
  });
  if (isMobile()) switchMobileView('edit');
  if (isTouch()) document.body.classList.add('touch');
  window.addEventListener('resize', debounce(() => {
    if (S.ui.mview && isMobile()) { /* 保持当前视图 */ }
    if (!$('#tabEffect').classList.contains('hidden')) renderEffect();
  }, 220));
}

/* PWA：装到桌面/主屏后离线也能打开界面（数据还是走本地服务） */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('/static/sw.js').catch(() => {});
  // 移动端提示「添加到主屏幕」（已经是独立窗口打开时不再提示）
  try {
    if (!isMobile()) return;
    const standalone = window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    const shown = localStorage.getItem('rt_install_tip') === 'off';
    if (!standalone && !shown) setTimeout(() => $('#installTip').classList.remove('hidden'), 2500);
    const ok = $('#installOk');
    if (ok) ok.onclick = () => {
      $('#installTip').classList.add('hidden');
      try { localStorage.setItem('rt_install_tip', 'off'); } catch (e) {}
    };
  } catch (e) { /* 忽略 */ }
}

/* ============================================================
   14. 事件绑定 & 启动
   ============================================================ */
function closeTopMenu() {
  const menu = $('#topMenu');
  const btn = $('#btnMore');
  if (menu) menu.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function bindUI() {
  $('#searchInput').oninput = debounce(e => { S.ui.search = e.target.value; renderLib(); }, 120);
  $('#searchClear').onclick = () => { $('#searchInput').value = ''; S.ui.search = ''; renderLib(); };
  $$('#searchSeg .seg-btn').forEach(b => b.onclick = () => {
    $$('#searchSeg .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); S.ui.scope = b.dataset.scope; renderLib();
  });
  $('#libList').onclick = ev => {
    const g = ev.target.closest('.sg-head');
    if (g) { const id = g.parentElement.dataset.sec; S.ui.closedLib[id] = !S.ui.closedLib[id]; renderLib(); return; }
    const e = ev.target.closest('.entry');
    if (!e) return;
    addField(e.dataset.sec, e.dataset.code);
    if (isMobile()) setTimeout(() => switchMobileView('edit'), 60);
  };
  $('#libList').onmouseover = ev => {
    const e = ev.target.closest('.entry'); if (!e) return;
    const fm = fieldMeta(e.dataset.sec, e.dataset.code);
    if (!fm) return;
    const tip = $('#tipBox');
    tip.innerHTML = '<span class="tt">' + esc(fm.trans) + ' <span class="tc">' + esc(fm.code) + '</span></span>' +
      '<div class="tv">' + esc(fm.vtype || '') + '　段：' + esc(e.dataset.sec) + '</div>' +
      '<div class="td">' + esc((fm.desc || '').slice(0, 320)) + '</div>' +
      (fm.ex ? '<div class="te">' + esc(fm.ex.slice(0, 220)) + '</div>' : '');
    tip.classList.remove('hidden');
    const r = e.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - (tip.offsetWidth || 380) - 10, r.right + 12) + 'px';
    tip.style.top = Math.max(8, Math.min(window.innerHeight - (tip.offsetHeight || 200) - 10, r.top - 6)) + 'px';
  };
  $('#libList').onmouseleave = () => $('#tipBox').classList.add('hidden');

  $('#tplBtns').innerHTML = TEMPLATES.map((t, i) => '<button data-tpl-quick="' + i + '">' + esc(t.name.slice(2)) + '</button>').join('');
  $('#tplBtns').onclick = ev => {
    const b = ev.target.closest('[data-tpl-quick]'); if (!b) return;
    const t = TEMPLATES[parseInt(b.dataset.tplQuick, 10)];
    if (S.doc.sections.length && !confirm('当前编辑区内容会被替换，继续吗？')) return;
    S.doc.sections = t.build(); S.doc.path = null; S.doc.name = '新单位.ini'; markDirty();
    S.ui.activeSection = S.doc.sections[0].id; renderAll();
    toast('已载入骨架：<b>' + esc(t.name) + '</b>', 'ok');
  };

  $('#btnNew').onclick = newDoc;
  $('#btnTpl').onclick = openTplModal;
  $('#btnOpen').onclick = () => {
    switchSide('fs');
    if (!S.fs.path) fsGo(S.modRoot || '');
  };
  $('#btnSave').onclick = saveDoc;
  $('#btnSaveAs').onclick = () => saveAs();
  $('#btnImport').onclick = openImportModal;
  $('#btnExport').onclick = openExportModal;
  $('#btnHelp').onclick = openHelpModal;
  bindFs();
  $('#btnAudit').onclick = () => openAuditModal();
  $('#btnAnim').onclick = () => { if (typeof openStudio === 'function') openStudio(null); };
  $('#bagSearch').oninput = debounce(renderBag, 150);
  $('#bagSearchClear').onclick = () => { $('#bagSearch').value = ''; renderBag(); };
  $('#missScan').onchange = async ev => {
    if (!ev.target.checked) { S.scan = null; renderBagMiss(); return; }
    $('#missHint').textContent = '正在扫描模组…';
    await ensureScan(true);
    renderBagMiss();
  };
  $('#btnAddSection').onclick = () => {
    const name = prompt('新段名（不要带方括号，例如 turret_2 / action_技能 / resource_钍）:', 'custom_段');
    if (!name) return;
    S.doc.sections.push(newSection(name.trim()));
    markDirty(); renderAll();
  };
  $('#btnCollapseAll').onclick = () => { S.doc.sections.forEach(s => s.collapsed = true); renderAll(); };
  $('#btnExpandAll').onclick = () => { S.doc.sections.forEach(s => s.collapsed = false); renderAll(); };
  $('#btnOrganize').onclick = () => {
    for (const s of S.doc.sections) {
      const id = deriveSecId(s.name);
      const rank = e => { const m = fieldMeta(id, e.key); return m ? m._order : 99999; };
      s.entries.sort((a, b) => rank(a) - rank(b));
    }
    S.doc.sections.sort((a, b) => secRank(a) - secRank(b));
    markDirty(); renderAll(); toast('已按代码表推荐顺序整理', 'ok');
  };
  bindMidTools();
  const moreBtn = $('#btnMore');
  const topMenu = $('#topMenu');
  if (moreBtn && topMenu) {
    moreBtn.onclick = ev => {
      ev.stopPropagation();
      const open = topMenu.classList.toggle('open');
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    topMenu.onclick = ev => {
      if (ev.target.closest('button')) setTimeout(closeTopMenu, 0);
    };
    document.addEventListener('click', ev => {
      if (!ev.target.closest('.top-menu-wrap')) closeTopMenu();
    });
  }
  if ($('#mobSave')) $('#mobSave').onclick = () => saveDoc();
  if ($('#stIssue')) {
    $('#stIssue').onclick = () => switchTab('check');
    $('#stIssue').title = '点击查看错误检查';
  }
  const secRank = s => {
    const order = ['core', 'graphics', 'attack', 'turret', 'projectile', 'movement', 'ai', 'canBuild',
      'leg_#', 'attachment', 'effect', 'animation', 'action', 'decal', 'placementRule',
      'global_resource', 'resource', 'template', 'comment', 'mod', 'music'];
    const i = order.indexOf(deriveSecId(s.name));
    return i < 0 ? 99 : i;
  };
  $('#modalMask').onclick = ev => { if (ev.target.id === 'modalMask') closeModal(); };
  $('#modalClose').onclick = closeModal;

  $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  $('#optBlank').onchange = renderCode;
  $('#optComment').onchange = renderCode;
  $('#btnCopy').onclick = () => {
    navigator.clipboard.writeText(serialize(S.doc, { blank: $('#optBlank').checked, comment: $('#optComment').checked }))
      .then(() => toast('代码已复制', 'ok'), () => toast('复制失败', 'err'));
  };
  $('#btnDownload').onclick = () => downloadText(S.doc.name, serialize(S.doc, { blank: $('#optBlank').checked, comment: $('#optComment').checked }));
  $('#fxGrid').onchange = renderEffect;
  $('#fxRange').onchange = renderEffect;
  $('#fxSprite').onchange = renderEffect;
  $('#fxCloseup').onchange = renderEffect;
  $('#fxTurrets').onchange = renderEffect;
  bindFxZoom();

  document.addEventListener('keydown', ev => {
    if (ev.ctrlKey && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveDoc(); }
    else if (ev.ctrlKey && ev.key.toLowerCase() === 'o') { ev.preventDefault(); openOpenModal(); }
    else if (ev.ctrlKey && ev.key.toLowerCase() === 'n') { ev.preventDefault(); newDoc(); }
    else if (ev.ctrlKey && ev.key.toLowerCase() === 'k') { ev.preventDefault(); $('#searchInput').focus(); }
    else if (ev.ctrlKey && ev.key.toLowerCase() === 'b') { ev.preventDefault(); switchTab('bag'); }
    else if (ev.ctrlKey && ev.key.toLowerCase() === 'e') { ev.preventDefault(); switchSide(S.ui.side === 'fs' ? 'lib' : 'fs'); }
    else if (ev.key === '/' && !ev.ctrlKey && !ev.metaKey && !ev.altKey &&
             !/^(INPUT|TEXTAREA|SELECT)$/.test(((document.activeElement || {}).tagName || ''))) {
      ev.preventDefault();
      if ($('#fieldFilter')) $('#fieldFilter').focus();
    }
    else if (ev.key === 'Escape') { closeTopMenu(); closeModal(); }
  });
  window.addEventListener('beforeunload', ev => {
    if (S.doc.dirty) { ev.preventDefault(); ev.returnValue = ''; }
  });
}

async function boot() {
  try {
    // 上次用过的模组目录
    try {
      const c = await (await fetch('/api/config')).json();
      S.modRoot = c.modRoot || '';
    } catch (e) { /* 忽略 */ }
    const r = await fetch('/api/meta');
    if (!r.ok) throw new Error((await r.json()).error || 'meta 读取失败');
    S.meta = await r.json();
    buildIndex();
    $('#metaInfo').textContent = S.meta.source + ' · 生成于 ' + S.meta.generated;
    $('#stMeta').textContent = '代码表：' + S.meta.source + '（共 ' +
      S.meta.sections.reduce((a, s) => a + s.groups.reduce((b, g) => b + g.entries.length, 0), 0) + ' 条代码）';
    renderRefTools();
    bindUI();
    bindLayout();
    bindMobile();
    setupSafeArea();
    registerSW();
    await loadBag();
    scheduleBackgroundScan(1200);   // 空闲后再扫一次模组，先把界面和单位预览让出来
    S.fs.path = '';
    // 默认给一个战斗单位骨架，打开就能看到效果
    S.doc.sections = TEMPLATES[1].build();
    S.ui.activeSection = S.doc.sections[0].id;
    markDirty(false);
    renderAll();
    renderRef();
  } catch (e) {
    document.body.innerHTML = '<div style="padding:60px;font-size:15px;color:#ff5f6d;font-family:system-ui">' +
      '加载代码表失败：' + esc(e.message) + '<br><br>请先运行 <code>python build_data.py</code> 生成 data/code_table.json（需要代码表 xlsx 在编写器目录或上级目录）。</div>';
  }
}
boot();
