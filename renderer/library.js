'use strict';

/* ===========================================================================
 * 塔科夫资料库（独立窗口）—— renderer/library.html 的脚本
 *
 * 为什么这么写：
 *  - 无框架、原生 DOM：和 renderer/map.js 一个路子，加一列只改一个数组，不用再学一层东西。
 *  - 数据全部 fetch('app://data/xxx.json')（主进程注册的 app:// 协议），运行时不联网；
 *    本文件里不允许出现任何外部网址的 fetch —— 外链一律交给 api.openExternal。
 *  - economy-dump.json 8MB 启动时只读一次并缓存在 state.data.economy；
 *    market / bosses / task-guides 等页签第一次点开时懒加载，省首屏时间也省内存。
 *  - 任何数据文件缺失都只让"当前页签"显示中文占位，绝不让窗口白屏：
 *    render() 把每个页签的渲染都包在 try/catch 里。
 *  - 所有进入 innerHTML 的动态字符串必须过 escapeHtml（用全名而不是短别名，
 *    review 时一眼能看出哪里漏了转义）。
 * =========================================================================== */

const api = window.api;
const $ = function (sel) { return document.querySelector(sel); };

/* ===========================================================================
 * 1. 转义 / 格式化
 * =========================================================================== */

// 与 map.js 的 escapeHtml 完全一致：只放行 < > & " 之外的字符
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
    return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
  });
}

function toNum(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  return isFinite(v) ? v : null;
}

// 价格/数量统一千分位。数据里 null 极多（没成交的弹药、买不到的物品），
// 必须显示破折号而不是 "NaN" 或 "0 ₽"。
function num(n) {
  const v = toNum(n);
  return v == null ? '—' : Math.round(v).toLocaleString('en-US');
}
function rub(n) {
  const v = toNum(n);
  return v == null ? '—' : num(v) + ' ₽';
}
// 交换/制作里的 count 可能是小数（ref 的以物易物有 155.1 这种）
function countText(n) {
  const v = toNum(n);
  if (v == null) return '—';
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}
// 0~1 的比例 -> 整数百分比（刷新率、碎弹率、跳弹率）
function pctInt(x) {
  const v = toNum(x);
  return v == null ? '—' : Math.round(v * 100) + '%';
}
// 0~1 的比例 -> 一位小数百分比（惩罚类）
function pct1(x) {
  const v = toNum(x);
  return v == null ? '—' : (v * 100).toFixed(1) + '%';
}
// 小数修正值（弹药的精度/后座修正是 -0.1、0.28 这种，用整数 num() 会被抹成 0）
function dec2(x) {
  const v = toNum(x);
  return v == null ? '—' : v.toFixed(2);
}
// 跳蚤 48h 变化：ch48p 本身就是百分数（37.43 = +37.43%），原样用。
// 这里别乘/除 100：tools/fetch-economy.js 早期版本多乘过一次 100，
// 脚本已修正（见该文件 72~73 行注释），当前 economy-dump.json 是修正后重新生成的。
function ch48Percent(q) {
  if (!q || q.ch48p == null) return null;
  const v = Number(q.ch48p);
  return isFinite(v) ? v : null;
}
function changeHtml(q) {
  const p = ch48Percent(q);
  if (p == null) return '—';
  const cls = p > 0 ? 'up' : (p < 0 ? 'down' : '');
  const abs = q && q.ch48 != null ? '（' + (q.ch48 > 0 ? '+' : '') + num(q.ch48) + ' ₽）' : '';
  return '<span class="chg ' + cls + '">' + (p > 0 ? '+' : '') + p.toFixed(2) + '%</span>' + abs;
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = function (v) { return String(v).length < 2 ? '0' + v : String(v); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtDuration(sec) {
  const s = toNum(sec);
  if (s == null || s <= 0) return '—';
  if (s < 3600) return Math.round(s / 60) + ' 分钟';
  return (s / 3600).toFixed(1) + ' 小时';
}
function debounce(fn, ms) {
  let t = 0;
  return function () {
    const args = arguments;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(null, args); }, ms);
  };
}
function modeLabel() { return state.mode === 'pve' ? 'PVE' : 'PVP'; }
function matchText(text, q) { return String(text == null ? '' : text).toLowerCase().indexOf(q) >= 0; }

/* ===========================================================================
 * 2. 常量表
 * =========================================================================== */

// 页签顺序就是界面顺序；dumps = 这个页签需要哪些数据文件（缺一个就整页占位）
const TABS = [
  { id: 'items', label: '物品', dumps: ['economy'], ph: '搜索物品' },
  { id: 'ammo', label: '弹药', dumps: ['economy'], ph: '搜索弹药' },
  { id: 'gear', label: '防具', dumps: ['economy'], ph: '搜索防具' },
  { id: 'keys', label: '钥匙', dumps: ['economy'], ph: '搜索钥匙' },
  { id: 'collect', label: '收集', dumps: ['economy', 'market', 'requirements'], ph: '搜索物品' },
  { id: 'hideout', label: '藏身处', dumps: ['economy', 'market'], ph: '搜索模块' },
  { id: 'craft', label: '制作', dumps: ['economy', 'market'], ph: '搜索配方' },
  { id: 'barter', label: '交换', dumps: ['economy', 'market'], ph: '搜索交换' },
  { id: 'resale', label: '倒卖', dumps: ['economy'], ph: '搜索物品' },
  { id: 'ritual', label: '仪式圈', dumps: ['economy'], ph: '搜索物品' },
  { id: 'traits', label: '特质', dumps: ['traits'], ph: '搜索特质' },
  { id: 'boss', label: 'BOSS', dumps: ['bosses'], ph: '搜索 BOSS' },
  { id: 'btr', label: 'BTR', dumps: ['btr'], ph: '搜索地图' },
  { id: 'source', label: '来源', dumps: ['economy', 'market', 'bosses', 'taskGuides', 'btr', 'requirements', 'traits'], ph: '无需搜索' },
];

const DUMPS = {
  // script = 缺数据时告诉用户跑哪条命令（tools/fetch-*.js，见 README"数据更新"一节）
  economy: { file: 'economy-dump.json', script: 'npm run fetch:economy' },
  market: { file: 'market-dump.json', script: 'npm run fetch:market' },
  bosses: { file: 'bosses-dump.json', script: 'npm run fetch:bosses' },
  taskGuides: { file: 'task-guides.json', script: 'npm run fetch:guides' },
  btr: { file: 'btr-dump.json', script: 'npm run fetch:btr' },
  requirements: { file: 'requirements-dump.json', script: 'npm run fetch:requirements' },
  traits: { file: 'traits-dump.json', script: 'npm run fetch:traits' },
};

// 卢布：藏身处/交换的材料里它就是钱，按面值 1:1 计
const RUB_ID = '5449016a4bdc2d6f028b456f';

// 藏身处模块中文名：key 就是 dump 里的 normalizedName（dump 的 name 是 hideout_area_5_name 这种占位符）
const HIDEOUT_NAMES = {
  stash: '仓库', security: '安保', illumination: '照明', 'shooting-range': '靶场', heating: '供暖',
  vents: '通风', 'nutrition-unit': '营养部', lavatory: '卫生间', 'rest-space': '休息区',
  medstation: '医疗站', generator: '发电机', workbench: '工作台', 'water-collector': '集水器',
  'intelligence-center': '情报中心', 'defective-wall': '易碎墙', gym: '健身区',
  'bitcoin-farm': '比特币矿场', 'booze-generator': '酿酒处', library: '图书馆',
  'solar-power': '太阳能', 'weapon-rack': '武器架', 'gear-rack': '装备架',
  'hall-of-fame': '荣耀展柜', 'air-filtering-unit': '空气过滤单元', 'scav-case': 'Scav宝箱',
  'cultist-circle': '仪式圈',
};

// 口径：dump 里是 Caliber762x51 这种 graphql 枚举名，直接显示不好读
const CALIBER_ZH = {
  'Caliber127x99': '12.7×99', 'Caliber86x70': '8.6×70（.338 LM）', 'Caliber762x54R': '7.62×54R',
  'Caliber762x51': '7.62×51', 'Caliber545x39': '5.45×39', 'Caliber762x39': '7.62×39',
  'Caliber127x33': '12.7×33', 'Caliber556x45NATO': '5.56×45 NATO', 'Caliber93x64': '9.3×64',
  'Caliber9x39': '9×39', 'Caliber46x30': '4.6×30', 'Caliber58x42': '5.8×42', 'Caliber762x35': '7.62×35',
  'Caliber68x51': '6.8×51', 'Caliber127x55': '12.7×55', 'Caliber784x49': '7.84×49',
  'Caliber366TKM': '.366 TKM', 'Caliber23x75': '23×75', 'Caliber9x19PARA': '9×19 PARA',
  'Caliber1143x23ACP': '11.43×23 ACP', 'Caliber9x21': '9×21', 'Caliber12g': '12 号铅弹',
  'Caliber57x28': '5.7×28', 'Caliber762x25TT': '7.62×25 TT', 'Caliber9x33R': '9×33R',
  'Caliber20g': '20 号铅弹', 'Caliber9x18PM': '9×18 PM', 'Caliber40x46': '40×46',
  'Caliber20x1mm': '20×1mm', 'Caliber26x75': '26×75', 'Caliber40mmRU': '40mm RU',
};
function caliberLabel(c) {
  if (!c) return '—';
  return CALIBER_ZH[c] || String(c).replace(/^Caliber/, '');
}

// 防具类型：以 propsType 为准（types[] 里有些头盔没有 helmet 标记，靠它分不出来）
const GEAR_TYPES = [
  { key: 'helmet', label: '头盔', props: 'ItemPropertiesHelmet', type: 'helmet' },
  { key: 'armor', label: '防弹衣', props: 'ItemPropertiesArmor', type: 'armor' },
  { key: 'rig', label: '胸挂', props: 'ItemPropertiesChestRig', type: 'rig' },
  { key: 'plate', label: '附加装甲', props: 'ItemPropertiesArmorAttachment', type: '' },
];
function gearTypeOf(g) {
  for (const t of GEAR_TYPES) if (t.props === g.propsType) return t;
  const types = g.types || [];
  for (const t of GEAR_TYPES) if (t.type && types.indexOf(t.type) >= 0) return t;
  return { key: 'other', label: '其他', props: '', type: '' };
}

const SOURCE_LINKS = [
  { label: 'tarkov.dev（数据源）', url: 'https://tarkov.dev' },
  { label: '逃离塔科夫中文 Wiki', url: 'https://www.eftarkov.com' },
  { label: 'Battlestate Games（版权方）', url: 'https://www.escapefromtarkov.com' },
];

const LS_MODE = 'tarkov-lib-mode';
const LS_HIDEOUT = 'tarkov-lib-hideout-v1';
const LS_COLLECT = 'tarkov-lib-collect-v1';
const LS_TRAITS = 'tarkov-lib-traits-v1';
const PAGE_SIZE = 100;

/* ===========================================================================
 * 3. 全局状态与本地存储
 * =========================================================================== */

const state = {
  mode: 'regular',
  tab: 'items',
  q: '',
  sel: {},       // { 页签: 选中行 key }，切页签/切模式后据此恢复详情
  sorts: {},     // { 页签: { key, dir } }
  pages: {},     // { 页签: 页码 }
  filters: { category: '', caliber: '', gearType: '', station: '', trader: '' },
  data: {},      // { economy / market / bosses / taskGuides: dump 对象 }
  loadErr: {},   // 加载失败的 dump，避免每次渲染都重试同一个 404
  loading: {},   // 进行中的加载 Promise
  hideout: {},   // 藏身处勾选进度
  collect: {},   // 收集清单勾选（物品 id -> true）
  traits: { selected: [], budget: 20 },   // 特质模拟器（选择 + 点数预算）
  ritual: { threshold: 400000, limit: 5, plan: null, planFor: null, pending: null }, // 仪式圈 DP 结果缓存（limit = 每件最多买几件）
  btrSort: { key: 'spawnTime', dir: 'asc' }, // BTR 路线表排序（本地偏好，不落 localStorage）
};

let renderSeq = 0;      // 渲染序号：异步加载期间用户又切了页签时，丢掉过期的那次渲染
let pendingGoto = null; // 主进程在窗口刚打开就发来的跳转请求，等 economy 到货再执行

function lsGet(key, dflt) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? dflt : v;
  } catch (e) { return dflt; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, val); } catch (e) { /* 配额满/隐私模式：只是记不住，不影响用 */ }
}

function loadHideoutState() {
  try { state.hideout = JSON.parse(lsGet(LS_HIDEOUT, '{}')) || {}; } catch (e) { state.hideout = {}; }
}
function saveHideout() { lsSet(LS_HIDEOUT, JSON.stringify(state.hideout || {})); }

function loadCollect() {
  try { state.collect = JSON.parse(lsGet(LS_COLLECT, '{}')) || {}; } catch (e) { state.collect = {}; }
}
function saveCollect() { lsSet(LS_COLLECT, JSON.stringify(state.collect || {})); }

function loadTraitsState() {
  try {
    const raw = JSON.parse(lsGet(LS_TRAITS, '{}')) || {};
    state.traits.selected = Array.isArray(raw.selected)
      ? raw.selected.filter(function (x) { return typeof x === 'string'; })
      : [];
    const b = toNum(raw.budget);
    state.traits.budget = b == null ? 20 : Math.max(0, Math.round(b));
  } catch (e) {
    state.traits.selected = [];
    state.traits.budget = 20;
  }
}
function saveTraitsState() { lsSet(LS_TRAITS, JSON.stringify(state.traits)); }

/* ===========================================================================
 * 4. 数据加载与索引
 * =========================================================================== */

async function ensureDump(key) {
  if (state.data[key]) return state.data[key];
  if (state.loadErr[key]) return null;
  if (!state.loading[key]) {
    state.loading[key] = (async function () {
      const meta = DUMPS[key];
      try {
        const res = await fetch('app://data/' + meta.file);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        state.data[key] = await res.json();
      } catch (e) {
        // 只记警告 + 占位，不抛：某个数据缺失不应该让整个资料库不可用
        console.warn('[资料库] 数据缺失 ' + meta.file, e);
        state.loadErr[key] = e;
        state.data[key] = null;
      } finally {
        state.loading[key] = null;
      }
      // economy 到货后补跳：主进程发 library:goto 时数据往往还没解析完
      if (key === 'economy' && pendingGoto) {
        const g = pendingGoto;
        pendingGoto = null;
        applyGoto(g);
      }
    })();
  }
  await state.loading[key];
  return state.data[key] || null;
}

let econIndex = null;
function itemById(id) {
  if (!state.data.economy) return null;
  if (!econIndex) {
    const byId = new Map();
    for (const it of state.data.economy.items || []) byId.set(it.id, it);
    econIndex = byId;
  }
  return econIndex.get(id) || null;
}

function priceRec(item, mode) {
  if (!item || !item.p) return null;
  return item.p[mode] || item.p.regular || null;
}
// 统一"用哪个价"：当前最低价 -> 24h 均价 -> 基准价。所有成本/利润都走这里，
// 免得各页签各写一套导致同一件物品在不同页签价格不一致。
function fleaPrice(item, mode) {
  if (item && item.id === RUB_ID) return 1;
  const q = priceRec(item, mode);
  if (!q) return 0;
  if (q.last != null) return q.last;
  if (q.avg != null) return q.avg;
  if (q.base != null) return q.base;
  return 0;
}
function priceById(id, mode) {
  if (id === RUB_ID) return 1;
  return fleaPrice(itemById(id), mode);
}
function bestSell(item, mode) {
  const q = priceRec(item, mode);
  if (!q || !q.sell || !q.sell.length) return null;
  let best = null;
  for (const s of q.sell) {
    if (s && s.p != null && (!best || s.p > best.p)) best = s;
  }
  return best;
}
function traderName(id) {
  const traders = state.data.economy && state.data.economy.traders;
  const t = traders && traders[id];
  return t && t.name ? t.name : String(id == null ? '' : id);
}

/* ===========================================================================
 * 5. 详情面板（物品/弹药/防具/钥匙/藏身处共用）
 * =========================================================================== */

function showDetail(html) {
  const d = $('#detail');
  d.classList.remove('hidden');
  d.innerHTML = '<div class="detail-head"><span>详情</span>' +
    '<button type="button" class="detail-close" data-act="close-detail" title="收起详情（Esc）">×</button></div>' +
    '<div class="detail-body">' + html + '</div>';
  d.scrollTop = 0;
  wireImages(d);
}
function hideDetail() {
  const d = $('#detail');
  d.classList.add('hidden');
  d.innerHTML = '';
  state.sel[state.tab] = null;
}
// 图标用的是 app://data/item-icons/...，商品不一定有图标：加载失败就藏起来，
// 不要留一个碎图占位符。这里用 addEventListener 而不是 <img onerror>，
// 因为 CSP 的 script-src 不含 'unsafe-inline'，内联事件处理器会被直接拦掉。
function wireImages(root) {
  for (const img of root.querySelectorAll('img')) {
    if (img.dataset.wired) continue;
    img.dataset.wired = '1';
    img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
    if (img.complete && img.naturalWidth === 0) img.style.visibility = 'hidden';
  }
}
function statGrid(pairs) {
  let html = '<div class="stat-grid">';
  for (const p of pairs) {
    html += '<div class="stat"><span class="stat-k">' + escapeHtml(p[0]) + '</span><span class="stat-v">' + p[1] + '</span></div>';
  }
  return html + '</div>';
}
function sellTableHtml(item) {
  const q = priceRec(item, state.mode);
  const sells = (q && q.sell ? q.sell.slice() : []).filter(function (s) { return s && s.p != null; });
  if (!sells.length) return '<div class="detail-note">没有商人收购数据。</div>';
  sells.sort(function (a, b) { return b.p - a.p; });
  let html = '<table class="mini-table"><thead><tr><th>商人</th><th class="num">收购价</th></tr></thead><tbody>';
  for (const s of sells) html += '<tr><td>' + escapeHtml(traderName(s.t)) + '</td><td class="num">' + rub(s.p) + '</td></tr>';
  return html + '</tbody></table>';
}
function itemIconHtml(it, cls) {
  if (!it || !it.icon) return '<span class="thumb ' + (cls || '') + '"></span>';
  return '<img class="thumb ' + (cls || '') + '" loading="lazy" alt="" src="app://data/item-icons/' + escapeHtml(it.icon) + '" />';
}
function fleaBlockHtml(item) {
  const q = priceRec(item, state.mode) || {};
  let html = statGrid([
    ['基准价', rub(q.base)],
    ['当前最低价', rub(q.last)],
    ['24h 均价', rub(q.avg)],
    ['24h 最低 / 最高', rub(q.low24) + ' / ' + rub(q.high24)],
    ['48h 变化', changeHtml(q)],
    ['报价数', num(q.offers)],
  ]);
  html += '<div class="detail-note">数据时间：' + escapeHtml(fmtTime(q.updated || q.scan)) + '</div>';
  return html;
}

/* ===========================================================================
 * 6. 通用表格：排序 + 分页 + 选行
 * =========================================================================== */

function sortRows(rows, sort, columns) {
  if (!sort || !sort.key) return rows.slice();
  let col = null;
  for (const c of columns) if (c.key === sort.key) col = c;
  const value = col && col.value ? col.value : function (r) { return r[sort.key]; };
  const dir = sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort(function (a, b) {
    let va = value(a);
    let vb = value(b);
    const na = va == null || va === '';
    const nb = vb == null || vb === '';
    if (na && nb) return 0;
    if (na) return 1;   // 缺值永远沉底，正序倒序都一样（否则升序时一排破折号会顶到最前）
    if (nb) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    va = String(va);
    vb = String(vb);
    return va.localeCompare(vb, 'zh-Hans-CN') * dir;
  });
}

function tableHtml(cfg, slice) {
  const sort = state.sorts[cfg.tabId] || {};
  let head = '<thead><tr>';
  for (const c of cfg.columns) {
    const active = sort.key === c.key;
    const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const clickable = c.sortable !== false;
    let cls = c.align === 'num' ? 'num' : '';
    if (clickable) cls += (cls ? ' ' : '') + 'sortable';
    if (active) cls += (cls ? ' ' : '') + 'active';
    head += '<th class="' + cls + '"' +
      (clickable ? ' data-sort="' + escapeHtml(c.key) + '" data-dir="' + escapeHtml(c.sortDir || 'desc') + '"' : '') +
      (c.width ? ' style="width:' + escapeHtml(c.width) + '"' : '') + '>' +
      escapeHtml(c.label) + arrow + '</th>';
  }
  head += '</tr></thead>';

  let body = '<tbody>';
  if (!slice.length) {
    body += '<tr class="empty-row"><td colspan="' + cfg.columns.length + '">' + escapeHtml(cfg.emptyText || '没有匹配的数据。') + '</td></tr>';
  } else {
    for (let i = 0; i < slice.length; i++) {
      const r = slice[i];
      const isSel = cfg.selectedKey != null && cfg.keyOf(r) === cfg.selectedKey;
      body += '<tr tabindex="0"' + (isSel ? ' class="selected"' : '') + ' data-idx="' + i + '">';
      for (const c of cfg.columns) body += '<td class="' + (c.align === 'num' ? 'num' : '') + '">' + c.cell(r) + '</td>';
      body += '</tr>';
    }
  }
  body += '</tbody>';
  return '<table class="lib-table">' + head + body + '</table>';
}

function pagerHtml(page, pages, total) {
  let html = '<div class="pager">';
  if (pages > 1) html += '<button type="button" data-page="prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>';
  html += '<span class="page-info">第 ' + page + ' / ' + pages + ' 页 · 共 ' + num(total) + ' 条</span>';
  if (pages > 1) html += '<button type="button" data-page="next"' + (page >= pages ? ' disabled' : '') + '>下一页</button>';
  return html + '</div>';
}

function selectHtml(id, options, value, allLabel) {
  let html = '<select id="' + escapeHtml(id) + '"><option value="">' + escapeHtml(allLabel) + '</option>';
  for (const o of options) {
    html += '<option value="' + escapeHtml(o.value) + '"' + (o.value === value ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>';
  }
  return html + '</select>';
}

function onSortClick(tabId, key, defaultDir) {
  const cur = state.sorts[tabId];
  let dir = defaultDir || 'desc';
  if (cur && cur.key === key) dir = cur.dir === 'desc' ? 'asc' : 'desc';
  state.sorts[tabId] = { key: key, dir: dir };
  state.pages[tabId] = 1;
  render();
}

// 一次渲染 = 工具条 + 汇总 + 表格 + 分页；排序/分页/选行都在这里接事件
function renderList(cfg) {
  const host = $('#list-host');
  const tabId = cfg.tabId;
  let sort = state.sorts[tabId];
  if (!sort) {
    sort = { key: cfg.defaultSort.key, dir: cfg.defaultSort.dir };
    state.sorts[tabId] = sort;
  }
  let rows = sortRows(cfg.rows, sort, cfg.columns);
  const matched = rows.length;
  if (cfg.limit && rows.length > cfg.limit) rows = rows.slice(0, cfg.limit);
  let page = state.pages[tabId] || 1;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pages) page = pages;
  if (page < 1) page = 1;
  state.pages[tabId] = page;
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  let summary = cfg.summary;
  if (summary == null) {
    summary = '共 ' + num(matched) + ' 条';
    if (cfg.limit && matched > cfg.limit) summary += '（按当前排序取前 ' + cfg.limit + ' 条）';
  }
  let html = '';
  if (cfg.tools) html += '<div class="list-tools">' + cfg.tools + '</div>';
  html += '<div class="list-summary">' + summary + '</div>';
  html += '<div class="table-wrap">' + tableHtml(cfg, slice) + '</div>';
  html += pagerHtml(page, pages, rows.length);
  host.innerHTML = html;

  for (const th of host.querySelectorAll('th[data-sort]')) {
    th.addEventListener('click', function () {
      onSortClick(tabId, th.getAttribute('data-sort'), th.getAttribute('data-dir'));
    });
  }
  if (cfg.onSelect) {
    for (const tr of host.querySelectorAll('tbody tr[data-idx]')) {
      const pick = function () { cfg.onSelect(slice[Number(tr.getAttribute('data-idx'))]); };
      // 行里可能有勾选框：点它只是勾选，不要顺带把详情面板顶开
      tr.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('input, button, select, a')) return;
        pick();
      });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    }
  }
  const prev = host.querySelector('[data-page="prev"]');
  const next = host.querySelector('[data-page="next"]');
  if (prev) prev.addEventListener('click', function () { if (page > 1) { state.pages[tabId] = page - 1; render(); } });
  if (next) next.addEventListener('click', function () { if (page < pages) { state.pages[tabId] = page + 1; render(); } });
  if (cfg.wire) cfg.wire(host);
  wireImages(host);
}

/* ===========================================================================
 * 7. 各页签
 * =========================================================================== */

function renderTab(tab) {
  switch (tab.id) {
    case 'items': renderItems(); break;
    case 'ammo': renderAmmo(); break;
    case 'gear': renderGear(); break;
    case 'keys': renderKeys(); break;
    case 'hideout': renderHideout(); break;
    case 'craft': renderCraft(); break;
    case 'barter': renderBarter(); break;
    case 'resale': renderResale(); break;
    case 'collect': renderCollect(); break;
    case 'ritual': renderRitual(); break;
    case 'traits': renderTraits(); break;
    case 'boss': renderBoss(); break;
    case 'btr': renderBtr(); break;
    case 'source': renderSource(); break;
    default: $('#list-host').innerHTML = '<div class="placeholder">未知页签。</div>';
  }
}

/* ---------- 7.1 物品 ---------- */

function handbookCategoryOptions() {
  const cats = (state.data.economy && state.data.economy.categories) || [];
  const byId = {};
  for (const c of cats) byId[c.id] = c;
  const opts = [];
  for (const c of cats) {
    if (!c.handbook) continue;
    const parent = c.parent && byId[c.parent] ? byId[c.parent].name : '';
    // handbook 分类里有重名（两个"背包"），加父分类名区分
    opts.push({ value: c.id, label: parent && parent !== c.name ? parent + ' / ' + c.name : c.name });
  }
  opts.sort(function (a, b) { return a.label.localeCompare(b.label, 'zh-Hans-CN'); });
  return opts;
}

function itemRow(it) {
  const q = priceRec(it, state.mode) || {};
  const flea = q.last != null ? q.last : (q.avg != null ? q.avg : q.base);
  const cells = (it.w || 0) * (it.h || 0);
  const best = bestSell(it, state.mode);
  return {
    it: it, key: it.id, name: it.name, cells: cells,
    flea: flea == null ? null : flea,
    perSlot: flea != null && cells > 0 ? flea / cells : null,
    best: best ? best.p : null,
    weight: it.weight,
  };
}

const ITEM_COLUMNS = [
  { key: 'icon', label: '', sortable: false, width: '34px', cell: function (r) { return itemIconHtml(r.it); } },
  { key: 'name', label: '名称', sortDir: 'asc', value: function (r) { return r.name; }, cell: function (r) {
    return '<span class="cell-name">' + escapeHtml(r.name) + '</span><span class="cell-sub">' + escapeHtml(r.it.short || '') + '</span>';
  } },
  { key: 'cells', label: '格数', sortDir: 'desc', align: 'num', value: function (r) { return r.cells; }, cell: function (r) { return escapeHtml((r.it.w || 0) + '×' + (r.it.h || 0)); } },
  { key: 'flea', label: '当前跳蚤价', sortDir: 'desc', align: 'num', value: function (r) { return r.flea; }, cell: function (r) { return rub(r.flea); } },
  { key: 'perSlot', label: '单格价值', sortDir: 'desc', align: 'num', value: function (r) { return r.perSlot; }, cell: function (r) { return rub(r.perSlot); } },
  { key: 'best', label: '商人收购', sortDir: 'desc', align: 'num', value: function (r) { return r.best; }, cell: function (r) { return rub(r.best); } },
  { key: 'weight', label: '重量', sortDir: 'asc', align: 'num', value: function (r) { return r.weight; }, cell: function (r) { return r.weight == null ? '—' : Number(r.weight).toFixed(2) + ' kg'; } },
];

function renderItems() {
  const all = (state.data.economy && state.data.economy.items) || [];
  const q = state.q.trim().toLowerCase();
  const cat = state.filters.category;
  const rows = [];
  for (const it of all) {
    if (q && !(matchText(it.name, q) || matchText(it.short, q) || matchText(it.id, q) || matchText(it.nameEn, q) || matchText(it.shortEn, q))) continue;
    if (cat && it.cat !== cat && (it.cats || []).indexOf(cat) < 0) continue;
    rows.push(itemRow(it));
  }
  const tools = '<label>分类 ' + selectHtml('f-category', handbookCategoryOptions(), cat, '全部分类') + '</label>';
  renderList({
    tabId: 'items', columns: ITEM_COLUMNS, rows: rows, defaultSort: { key: 'perSlot', dir: 'desc' },
    tools: tools, keyOf: function (r) { return r.key; }, selectedKey: state.sel.items,
    emptyText: '没有匹配的物品。',
    onSelect: function (r) { state.sel.items = r.key; showItemDetail(r.key); },
    wire: function (host) {
      const s = host.querySelector('#f-category');
      if (s) s.addEventListener('change', function () { state.filters.category = s.value; state.pages.items = 1; render(); });
    },
  });
  if (state.sel.items) showItemDetail(state.sel.items);
}

function showItemDetail(id) {
  const it = itemById(id);
  if (!it) { hideDetail(); return; }
  const q = priceRec(it, state.mode) || {};
  const flea = q.last != null ? q.last : (q.avg != null ? q.avg : q.base);
  const cells = (it.w || 0) * (it.h || 0);
  const perSlot = flea != null && cells > 0 ? flea / cells : null;
  let html = '<div class="detail-title">' + itemIconHtml(it, 'big') +
    '<div><div class="detail-name">' + escapeHtml(it.name) + '</div>' +
    '<div class="detail-sub">' + escapeHtml(it.short || '') + (it.nameEn ? ' · ' + escapeHtml(it.nameEn) : '') + '</div>' +
    '<div class="detail-sub mono">' + escapeHtml(it.id) + '</div></div></div>';
  html += statGrid([
    ['尺寸', escapeHtml((it.w || 0) + '×' + (it.h || 0)) + '（' + cells + ' 格）'],
    ['重量', it.weight == null ? '—' : Number(it.weight).toFixed(2) + ' kg'],
    ['单格价值', rub(perSlot)],
    ['跳蚤解锁等级', it.minFlea == null ? '—' : 'Lv ' + it.minFlea],
  ]);
  html += '<h4>跳蚤市场（' + escapeHtml(modeLabel()) + '）</h4>' + fleaBlockHtml(it);
  html += '<h4>各商人收购价</h4>' + sellTableHtml(it);
  html += '<div class="detail-actions">' +
    '<button type="button" class="link-btn" data-act="open-url" data-url="https://www.eftarkov.com/item/' + escapeHtml(it.id) + '" title="在浏览器中打开中文 Wiki 的物品页">打开中文 Wiki</button>' +
    '</div>';
  showDetail(html);
}

/* ---------- 7.2 弹药 ---------- */

function ammoCaliberOptions(all) {
  const set = {};
  for (const a of all) if (a.caliber) set[a.caliber] = 1;
  const arr = [];
  for (const c of Object.keys(set)) arr.push({ value: c, label: caliberLabel(c) });
  arr.sort(function (a, b) { return a.label.localeCompare(b.label, 'zh-Hans-CN'); });
  return arr;
}

function renderAmmo() {
  const all = (state.data.economy && state.data.economy.ammo) || [];
  const q = state.q.trim().toLowerCase();
  const cal = state.filters.caliber;
  const rows = [];
  let noFlea = 0;
  for (const a of all) {
    if (cal && a.caliber !== cal) continue;
    if (q && !(matchText(a.name, q) || matchText(a.short, q) || matchText(a.id, q))) continue;
    const p = priceRec(a, state.mode) || {};
    const best = bestSell(a, state.mode);
    const avg = p.avg != null ? p.avg : (p.last != null ? p.last : null);
    if (avg == null && p.base != null) noFlea++;
    rows.push({
      a: a, key: a.id, name: a.name, caliber: caliberLabel(a.caliber),
      pen: a.penetrationPower, dmg: a.damage, armor: a.armorDamage,
      frag: a.fragmentationChance, ric: a.ricochetChance,
      acc: a.accuracyModifier, recoil: a.recoilModifier, speed: a.initialSpeed,
      avg: avg, base: p.base == null ? null : p.base, best: best ? best.p : null,
    });
  }
  const columns = [
    { key: 'name', label: '名称', sortDir: 'asc', value: function (r) { return r.name; }, cell: function (r) {
      return '<span class="cell-name">' + escapeHtml(r.name) + '</span><span class="cell-sub">' + escapeHtml(r.a.short || '') + '</span>';
    } },
    { key: 'caliber', label: '口径', sortDir: 'asc', value: function (r) { return r.caliber; }, cell: function (r) { return escapeHtml(r.caliber); } },
    { key: 'pen', label: '穿透', sortDir: 'desc', align: 'num', value: function (r) { return r.pen; }, cell: function (r) { return num(r.pen); } },
    { key: 'dmg', label: '肉伤', sortDir: 'desc', align: 'num', value: function (r) { return r.dmg; }, cell: function (r) { return num(r.dmg); } },
    { key: 'armor', label: '甲伤', sortDir: 'desc', align: 'num', value: function (r) { return r.armor; }, cell: function (r) { return num(r.armor); } },
    { key: 'frag', label: '碎弹%', sortDir: 'desc', align: 'num', value: function (r) { return r.frag; }, cell: function (r) { return pctInt(r.frag); } },
    { key: 'ric', label: '跳弹%', sortDir: 'desc', align: 'num', value: function (r) { return r.ric; }, cell: function (r) { return pctInt(r.ric); } },
    { key: 'acc', label: '精度', sortDir: 'desc', align: 'num', value: function (r) { return r.acc; }, cell: function (r) { return dec2(r.acc); } },
    { key: 'recoil', label: '后座', sortDir: 'asc', align: 'num', value: function (r) { return r.recoil; }, cell: function (r) { return dec2(r.recoil); } },
    { key: 'speed', label: '初速', sortDir: 'desc', align: 'num', value: function (r) { return r.speed; }, cell: function (r) { return num(r.speed); } },
    { key: 'avg', label: '跳蚤均价', sortDir: 'desc', align: 'num', value: function (r) { return r.avg != null ? r.avg : r.base; }, cell: function (r) {
      if (r.avg != null) return rub(r.avg);
      if (r.base != null) return '<span class="muted" title="暂无跳蚤成交价，显示基准价">' + rub(r.base) + ' *</span>';
      return '—';
    } },
    { key: 'best', label: '最好的商人收购', sortDir: 'desc', align: 'num', value: function (r) { return r.best; }, cell: function (r) { return rub(r.best); } },
  ];
  const tools = '<label>口径 ' + selectHtml('f-caliber', ammoCaliberOptions(all), cal, '全部口径') + '</label>' +
    (noFlea ? '<span class="muted">带 * 暂无跳蚤成交价，显示基准价</span>' : '');
  renderList({
    tabId: 'ammo', columns: columns, rows: rows, defaultSort: { key: 'pen', dir: 'desc' },
    tools: tools, keyOf: function (r) { return r.key; }, selectedKey: state.sel.ammo,
    emptyText: '没有匹配的弹药。',
    onSelect: function (r) { state.sel.ammo = r.key; showAmmoDetail(r.key); },
    wire: function (host) {
      const s = host.querySelector('#f-caliber');
      if (s) s.addEventListener('change', function () { state.filters.caliber = s.value; state.pages.ammo = 1; render(); });
    },
  });
  if (state.sel.ammo) showAmmoDetail(state.sel.ammo);
}

function showAmmoDetail(id) {
  const a = ((state.data.economy && state.data.economy.ammo) || []).filter(function (x) { return x.id === id; })[0];
  if (!a) { hideDetail(); return; }
  let html = '<div class="detail-title"><div><div class="detail-name">' + escapeHtml(a.name) + '</div>' +
    '<div class="detail-sub">' + escapeHtml(a.short || '') + ' · ' + escapeHtml(caliberLabel(a.caliber)) + '</div>' +
    '<div class="detail-sub mono">' + escapeHtml(a.id) + '</div></div></div>';
  html += statGrid([
    ['穿透力', num(a.penetrationPower)],
    ['肉伤', num(a.damage)],
    ['甲伤', num(a.armorDamage)],
    ['碎弹率', pctInt(a.fragmentationChance)],
    ['跳弹率', pctInt(a.ricochetChance)],
    ['初速', num(a.initialSpeed) + ' m/s'],
    ['精度修正', dec2(a.accuracyModifier)],
    ['后座修正', dec2(a.recoilModifier)],
    ['堆叠上限', num(a.stackMaxSize)],
    ['重量', a.weight == null ? '—' : Number(a.weight).toFixed(3) + ' kg'],
  ]);
  html += '<h4>跳蚤 / 商人（' + escapeHtml(modeLabel()) + '）</h4>' + fleaBlockHtml(a);
  html += '<h4>各商人收购价</h4>' + sellTableHtml(a);
  showDetail(html);
}

/* ---------- 7.3 防具 ---------- */

function renderGear() {
  const all = (state.data.economy && state.data.economy.gear) || [];
  const q = state.q.trim().toLowerCase();
  const typeFilter = state.filters.gearType;
  const rows = [];
  for (const g of all) {
    const t = gearTypeOf(g);
    if (typeFilter && t.key !== typeFilter) continue;
    if (q && !(matchText(g.name, q) || matchText(g.short, q) || matchText(g.id, q))) continue;
    const p = priceRec(g, state.mode) || {};
    const best = bestSell(g, state.mode);
    rows.push({
      g: g, key: g.id, name: g.name, type: t.label, typeKey: t.key,
      cls: g.class, durability: g.durability, material: g.material,
      zones: (g.zones || []).length, ergo: g.ergoPenalty, speed: g.speedPenalty, turn: g.turnPenalty,
      weight: g.weight, avg: p.avg != null ? p.avg : (p.last != null ? p.last : null), best: best ? best.p : null,
    });
  }
  const columns = [
    { key: 'name', label: '名称', sortDir: 'asc', value: function (r) { return r.name; }, cell: function (r) {
      return '<span class="cell-name">' + escapeHtml(r.name) + '</span><span class="cell-sub">' + escapeHtml(r.g.short || '') + '</span>';
    } },
    { key: 'type', label: '类型', sortDir: 'asc', value: function (r) { return r.type; }, cell: function (r) { return escapeHtml(r.type); } },
    { key: 'cls', label: '防弹等级', sortDir: 'desc', align: 'num', value: function (r) { return r.cls; }, cell: function (r) { return r.cls == null ? '—' : 'Lv ' + r.cls; } },
    { key: 'durability', label: '耐久', sortDir: 'desc', align: 'num', value: function (r) { return r.durability; }, cell: function (r) { return num(r.durability); } },
    { key: 'material', label: '材质', sortDir: 'asc', value: function (r) { return r.material; }, cell: function (r) { return escapeHtml(r.material || '—'); } },
    { key: 'zones', label: '防护部位', sortDir: 'desc', align: 'num', value: function (r) { return r.zones; }, cell: function (r) { return num(r.zones) + ' 处'; } },
    { key: 'ergo', label: '人机惩罚', sortDir: 'desc', align: 'num', value: function (r) { return r.ergo; }, cell: function (r) { return pct1(r.ergo); } },
    { key: 'speed', label: '移速惩罚', sortDir: 'desc', align: 'num', value: function (r) { return r.speed; }, cell: function (r) { return pct1(r.speed); } },
    { key: 'turn', label: '转向惩罚', sortDir: 'desc', align: 'num', value: function (r) { return r.turn; }, cell: function (r) { return pct1(r.turn); } },
    { key: 'weight', label: '重量', sortDir: 'asc', align: 'num', value: function (r) { return r.weight; }, cell: function (r) { return r.weight == null ? '—' : Number(r.weight).toFixed(2) + ' kg'; } },
    { key: 'avg', label: '跳蚤均价', sortDir: 'desc', align: 'num', value: function (r) { return r.avg != null ? r.avg : r.best; }, cell: function (r) { return rub(r.avg); } },
  ];
  const tools = '<label>类型 ' + selectHtml('f-gear-type', GEAR_TYPES.map(function (t) { return { value: t.key, label: t.label }; }), typeFilter, '全部类型') + '</label>';
  renderList({
    tabId: 'gear', columns: columns, rows: rows, defaultSort: { key: 'cls', dir: 'desc' },
    tools: tools, keyOf: function (r) { return r.key; }, selectedKey: state.sel.gear,
    emptyText: '没有匹配的防具。',
    onSelect: function (r) { state.sel.gear = r.key; showGearDetail(r.key); },
    wire: function (host) {
      const s = host.querySelector('#f-gear-type');
      if (s) s.addEventListener('change', function () { state.filters.gearType = s.value; state.pages.gear = 1; render(); });
    },
  });
  if (state.sel.gear) showGearDetail(state.sel.gear);
}

function showGearDetail(id) {
  const g = ((state.data.economy && state.data.economy.gear) || []).filter(function (x) { return x.id === id; })[0];
  if (!g) { hideDetail(); return; }
  const zones = g.zones || [];
  let html = '<div class="detail-title"><div><div class="detail-name">' + escapeHtml(g.name) + '</div>' +
    '<div class="detail-sub">' + escapeHtml(g.short || '') + ' · ' + escapeHtml(gearTypeOf(g).label) + '</div>' +
    '<div class="detail-sub mono">' + escapeHtml(g.id) + '</div></div></div>';
  html += statGrid([
    ['防弹等级', g.class == null ? '—' : 'Lv ' + g.class],
    ['耐久', num(g.durability)],
    ['材质', escapeHtml(g.material || '—')],
    ['防护部位数', String(zones.length)],
    ['人机工效惩罚', pct1(g.ergoPenalty)],
    ['移速惩罚', pct1(g.speedPenalty)],
    ['转向惩罚', pct1(g.turnPenalty)],
    ['重量', g.weight == null ? '—' : Number(g.weight).toFixed(2) + ' kg'],
  ]);
  html += '<h4>防护部位</h4>';
  if (!zones.length) html += '<div class="detail-note">没有部位数据。</div>';
  else {
    let tags = '';
    for (const z of zones) tags += '<span class="tag">' + escapeHtml(z) + '</span>';
    html += '<div>' + tags + '</div>';
  }
  html += '<h4>跳蚤 / 商人（' + escapeHtml(modeLabel()) + '）</h4>' + fleaBlockHtml(g);
  html += '<h4>各商人收购价</h4>' + sellTableHtml(g);
  showDetail(html);
}

/* ---------- 7.4 钥匙 ---------- */

function renderKeys() {
  const all = (state.data.economy && state.data.economy.keys) || [];
  const q = state.q.trim().toLowerCase();
  const rows = [];
  for (const k of all) {
    if (q && !(matchText(k.name, q) || matchText(k.short, q) || matchText(k.id, q))) continue;
    const p = priceRec(k, state.mode) || {};
    const best = bestSell(k, state.mode);
    rows.push({
      k: k, key: k.id, name: k.name,
      uses: k.uses, weight: k.weight,
      flea: p.last != null ? p.last : (p.avg != null ? p.avg : p.base),
      best: best ? best.p : null,
    });
  }
  const columns = [
    { key: 'name', label: '名称', sortDir: 'asc', value: function (r) { return r.name; }, cell: function (r) {
      return '<span class="cell-name">' + escapeHtml(r.name) + '</span><span class="cell-sub">' + escapeHtml(r.k.short || '') + '</span>';
    } },
    { key: 'uses', label: '使用次数', sortDir: 'desc', align: 'num', value: function (r) { return r.uses; }, cell: function (r) { return num(r.uses); } },
    { key: 'weight', label: '重量', sortDir: 'asc', align: 'num', value: function (r) { return r.weight; }, cell: function (r) { return r.weight == null ? '—' : Number(r.weight).toFixed(2) + ' kg'; } },
    { key: 'flea', label: '跳蚤价', sortDir: 'desc', align: 'num', value: function (r) { return r.flea; }, cell: function (r) { return rub(r.flea); } },
    { key: 'best', label: '最好的商人收购', sortDir: 'desc', align: 'num', value: function (r) { return r.best; }, cell: function (r) { return rub(r.best); } },
  ];
  renderList({
    tabId: 'keys', columns: columns, rows: rows, defaultSort: { key: 'uses', dir: 'desc' },
    keyOf: function (r) { return r.key; }, selectedKey: state.sel.keys,
    emptyText: '没有匹配的钥匙。',
    onSelect: function (r) { state.sel.keys = r.key; showKeyDetail(r.key); },
  });
  if (state.sel.keys) showKeyDetail(state.sel.keys);
}

function showKeyDetail(id) {
  const k = ((state.data.economy && state.data.economy.keys) || []).filter(function (x) { return x.id === id; })[0];
  if (!k) { hideDetail(); return; }
  const p = priceRec(k, state.mode) || {};
  const best = bestSell(k, state.mode);
  let html = '<div class="detail-title"><div><div class="detail-name">' + escapeHtml(k.name) + '</div>' +
    '<div class="detail-sub">' + escapeHtml(k.short || '') + '</div>' +
    '<div class="detail-sub mono">' + escapeHtml(k.id) + '</div></div></div>';
  html += statGrid([
    ['使用次数', num(k.uses)],
    ['重量', k.weight == null ? '—' : Number(k.weight).toFixed(3) + ' kg'],
    ['当前跳蚤价', rub(p.last != null ? p.last : p.avg)],
    ['最好的商人收购', best ? rub(best.p) + '（' + escapeHtml(traderName(best.t)) + '）' : '—'],
  ]);
  html += '<h4>跳蚤市场（' + escapeHtml(modeLabel()) + '）</h4>' + fleaBlockHtml(k);
  html += '<h4>各商人收购价</h4>' + sellTableHtml(k);
  showDetail(html);
}

/* ---------- 7.5 藏身处 ---------- */

function hideoutModules() {
  const m = state.data.market;
  return (m && m.hideout && m.hideout.modules) || [];
}
function hideoutName(mod) {
  return HIDEOUT_NAMES[mod.normalizedName] || mod.normalizedName || mod.name || mod.id;
}
function hideoutLevelState(norm, level) {
  if (!state.hideout[norm]) state.hideout[norm] = {};
  const m = state.hideout[norm];
  const key = String(level);
  if (!m[key]) m[key] = { done: false, items: {} };
  if (!m[key].items) m[key].items = {};
  return m[key];
}
function hideoutLevelCost(lv) {
  let sum = 0;
  for (const r of (lv && lv.requirements) || []) sum += priceById(r.item, state.mode) * (r.count || 0);
  return sum;
}
function hideoutModuleTotal(mod) {
  let sum = 0;
  for (const lv of mod.levels || []) sum += hideoutLevelCost(lv);
  return sum;
}
function isLevelDone(mod, lv) {
  const st = hideoutLevelState(mod.normalizedName, lv.level);
  if (st.done) return true;
  const reqs = lv.requirements || [];
  if (!reqs.length) return false;
  for (const r of reqs) if (!st.items[r.item]) return false;
  return true;
}
function hideoutModuleRemaining(mod) {
  let sum = 0;
  for (const lv of mod.levels || []) if (!isLevelDone(mod, lv)) sum += hideoutLevelCost(lv);
  return sum;
}
function hideoutRemainingTotal() {
  let sum = 0;
  for (const mod of hideoutModules()) sum += hideoutModuleRemaining(mod);
  return sum;
}

function renderHideout() {
  const q = state.q.trim().toLowerCase();
  const rows = [];
  for (const mod of hideoutModules()) {
    const nm = hideoutName(mod);
    if (q && !(matchText(nm, q) || matchText(mod.normalizedName, q))) continue;
    const levels = mod.levels || [];
    rows.push({
      key: mod.normalizedName, mod: mod, name: nm, levels: levels.length,
      total: hideoutModuleTotal(mod), remaining: hideoutModuleRemaining(mod),
      doneAll: levels.length > 0 && levels.every(function (lv) { return isLevelDone(mod, lv); }),
    });
  }
  const columns = [
    { key: 'name', label: '模块', sortDir: 'asc', value: function (r) { return r.name; }, cell: function (r) {
      return '<span class="cell-name">' + escapeHtml(r.name) + '</span><span class="cell-sub">' + escapeHtml(r.mod.normalizedName) + '</span>';
    } },
    { key: 'levels', label: '等级数', sortDir: 'desc', align: 'num', value: function (r) { return r.levels; }, cell: function (r) { return String(r.levels); } },
    { key: 'total', label: '总成本', sortDir: 'desc', align: 'num', value: function (r) { return r.total; }, cell: function (r) { return rub(r.total); } },
    { key: 'remaining', label: '剩余成本', sortDir: 'desc', align: 'num', value: function (r) { return r.remaining; }, cell: function (r) { return rub(r.remaining); } },
    { key: 'doneAll', label: '状态', sortDir: 'desc', value: function (r) { return r.doneAll ? 1 : 0; }, cell: function (r) {
      return r.doneAll ? '<span class="chg up">已建满</span>' : '<span class="muted">进行中</span>';
    } },
  ];
  const tools = '<div class="hideout-summary">' +
    '<span>剩余总成本：<b>' + rub(hideoutRemainingTotal()) + '</b></span>' +
    '<span>' + escapeHtml(modeLabel()) + ' 价格 · 已完成等级不计入</span>' +
    '<button type="button" id="hideout-reset" title="清空所有勾选与完成标记">清空进度</button>' +
    '</div>';
  renderList({
    tabId: 'hideout', columns: columns, rows: rows, defaultSort: { key: 'remaining', dir: 'desc' },
    tools: tools, keyOf: function (r) { return r.key; }, selectedKey: state.sel.hideout,
    emptyText: '没有匹配的模块。',
    onSelect: function (r) { state.sel.hideout = r.key; showHideoutDetail(r.key); },
    wire: function (host) {
      const btn = host.querySelector('#hideout-reset');
      if (btn) btn.addEventListener('click', function () {
        state.hideout = {};
        saveHideout();
        render();
      });
    },
  });
  if (state.sel.hideout) showHideoutDetail(state.sel.hideout);
}

function showHideoutDetail(norm) {
  const mod = hideoutModules().filter(function (m) { return m.normalizedName === norm; })[0];
  if (!mod) { hideDetail(); return; }
  let html = '<div class="detail-title"><div><div class="detail-name">' + escapeHtml(hideoutName(mod)) + '</div>' +
    '<div class="detail-sub">' + (mod.levels || []).length + ' 级 · 总成本 ' + rub(hideoutModuleTotal(mod)) +
    ' · 剩余 ' + rub(hideoutModuleRemaining(mod)) + '</div></div></div>';
  for (const lv of mod.levels || []) {
    const done = isLevelDone(mod, lv);
    const reqs = lv.requirements || [];
    const st = hideoutLevelState(mod.normalizedName, lv.level);
    html += '<div class="level-block' + (done ? ' done' : '') + '">';
    html += '<div class="level-head"><span class="lv-title">等级 ' + lv.level + '</span>';
    html += '<span>该级总成本 <span class="lv-total">' + rub(hideoutLevelCost(lv)) + '</span>' +
      (lv.constructionTime ? ' · 建造 ' + escapeHtml(fmtDuration(lv.constructionTime)) : '') + '</span>';
    html += '<button type="button" data-act="toggle-level" data-module="' + escapeHtml(mod.normalizedName) + '" data-level="' + lv.level + '">' +
      (done ? '撤销完成' : '完成') + '</button></div>';
    html += '<table class="req-table"><thead><tr><th style="width:28px"></th><th>材料</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th></tr></thead><tbody>';
    if (!reqs.length) html += '<tr><td colspan="5" class="muted">这一级不需要材料。</td></tr>';
    for (const r of reqs) {
      const it = itemById(r.item);
      const unit = priceById(r.item, state.mode);
      const checked = st.items[r.item];
      html += '<tr class="' + (checked ? 'req-done' : '') + '"><td>' +
        '<input type="checkbox" data-act="check-item" data-module="' + escapeHtml(mod.normalizedName) +
        '" data-level="' + lv.level + '" data-item="' + escapeHtml(r.item) + '"' + (checked ? ' checked' : '') + ' /></td>' +
        '<td>' + escapeHtml(it ? it.name : r.item) + '</td>' +
        '<td class="num">' + countText(r.count) + '</td>' +
        '<td class="num">' + rub(unit) + '</td>' +
        '<td class="num">' + rub(unit * (r.count || 0)) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  showDetail(html);
}

function toggleHideoutLevel(norm, level) {
  const mod = hideoutModules().filter(function (m) { return m.normalizedName === norm; })[0];
  if (!mod) return;
  const lv = (mod.levels || []).filter(function (x) { return x.level === level; })[0];
  if (!lv) return;
  const st = hideoutLevelState(norm, level);
  if (isLevelDone(mod, lv)) {
    st.done = false;
    st.items = {};
  } else {
    st.done = true;
    for (const r of lv.requirements || []) st.items[r.item] = true;
  }
  saveHideout();
  renderKeepDetailScroll();
}
function checkHideoutItem(norm, level, itemId, checked) {
  const st = hideoutLevelState(norm, level);
  st.done = false;   // 手改材料 = 这一级重新按"材料是否齐全"判定，不再算整级完成
  if (checked) st.items[itemId] = true;
  else delete st.items[itemId];
  saveHideout();
  renderKeepDetailScroll();
}
// 勾选材料时重渲染整页（26 个模块很快），但要记住详情面板的滚动位置，
// 否则每点一个复选框就跳回顶部，没法连续勾。
function renderKeepDetailScroll() {
  const d = $('#detail');
  const top = d ? d.scrollTop : 0;
  render().then(function () {
    const d2 = $('#detail');
    if (d2) d2.scrollTop = top;
  });
}

/* ---------- 7.6 制作 ---------- */

function stationLabel(stationId) {
  const mod = hideoutModules().filter(function (m) { return m.id === stationId; })[0];
  return mod ? hideoutName(mod) : (stationId || '—');
}
function matsText(list) {
  if (!list || !list.length) return '<span class="muted">无</span>';
  let html = '';
  for (const m of list) {
    html += '<span class="tag">' + escapeHtml(m.name) + ' ×' + countText(m.count) + (m.tool ? ' <span class="muted">（工具）</span>' : '') + '</span>';
  }
  return html;
}
function namesText(list) {
  if (!list || !list.length) return '<span class="muted">无</span>';
  let html = '';
  for (const r of list) html += '<span class="cell-name">' + escapeHtml(r.name) + '</span>';
  return html;
}
function countsText(list) {
  if (!list || !list.length) return '—';
  return list.map(function (r) { return countText(r.count); }).join(' / ');
}

function renderCraft() {
  const mk = state.data.market || {};
  const q = state.q.trim().toLowerCase();
  const stationFilter = state.filters.station;
  const stationSet = {};
  const rows = [];
  for (const c of mk.crafts || []) {
    if (c.mode && c.mode !== state.mode) continue;
    stationSet[c.stationId] = 1;
    if (stationFilter && c.stationId !== stationFilter) continue;
    let cost = 0;
    const mats = [];
    for (const r of c.require || []) {
      const it = itemById(r.item);
      const unit = priceById(r.item, state.mode);
      // 工具不消耗，只占设施槽位：算进"材料成本"会凭空抬高成本、压低利润
      if (!r.tool) cost += unit * (r.count || 0);
      mats.push({ name: it ? it.name : r.item, count: r.count, tool: !!r.tool });
    }
    let value = 0;
    const rewards = [];
    for (const r of c.reward || []) {
      const it = itemById(r.item);
      const unit = priceById(r.item, state.mode);
      value += unit * (r.count || 0);
      rewards.push({ name: it ? it.name : r.item, count: r.count });
    }
    const hours = (c.duration || 0) / 3600;
    const profit = value - cost;
    const station = stationLabel(c.stationId);
    const row = {
      key: c.id + '|' + (c.mode || 'regular'), rewards: rewards, mats: mats, cost: cost, value: value,
      profit: profit, hours: hours, perHour: hours > 0 ? profit / hours : profit,
      station: station, stationId: c.stationId, stationLevel: c.level,
    };
    if (q) {
      let hit = matchText(station, q);
      if (!hit) for (const m of mats) if (matchText(m.name, q)) { hit = true; break; }
      if (!hit) for (const r of rewards) if (matchText(r.name, q)) { hit = true; break; }
      if (!hit) continue;
    }
    rows.push(row);
  }
  const columns = [
    { key: 'reward', label: '产出物', sortDir: 'asc', value: function (r) { return r.rewards.length ? r.rewards[0].name : ''; }, cell: function (r) { return namesText(r.rewards); } },
    { key: 'rewardCount', label: '产出数量', sortDir: 'desc', align: 'num', value: function (r) { return r.rewards.length ? r.rewards[0].count : null; }, cell: function (r) { return escapeHtml(countsText(r.rewards)); } },
    { key: 'mats', label: '所需材料', sortable: false, cell: function (r) { return matsText(r.mats); } },
    { key: 'station', label: '设施', sortDir: 'asc', value: function (r) { return r.station; }, cell: function (r) { return escapeHtml(r.station) + ' <span class="muted">Lv' + escapeHtml(String(r.stationLevel == null ? '?' : r.stationLevel)) + '</span>'; } },
    { key: 'hours', label: '耗时(小时)', sortDir: 'asc', align: 'num', value: function (r) { return r.hours; }, cell: function (r) { return r.hours.toFixed(2); } },
    { key: 'cost', label: '材料成本', sortDir: 'desc', align: 'num', value: function (r) { return r.cost; }, cell: function (r) { return rub(r.cost); } },
    { key: 'value', label: '产出价值', sortDir: 'desc', align: 'num', value: function (r) { return r.value; }, cell: function (r) { return rub(r.value); } },
    { key: 'profit', label: '利润', sortDir: 'desc', align: 'num', value: function (r) { return r.profit; }, cell: function (r) { return '<span class="chg ' + (r.profit >= 0 ? 'up' : 'down') + '">' + rub(r.profit) + '</span>'; } },
    { key: 'perHour', label: '每小时利润', sortDir: 'desc', align: 'num', value: function (r) { return r.perHour; }, cell: function (r) { return '<span class="chg ' + (r.perHour >= 0 ? 'up' : 'down') + '">' + rub(r.perHour) + '</span>'; } },
  ];
  const stationOpts = Object.keys(stationSet).map(function (id) { return { value: id, label: stationLabel(id) }; });
  stationOpts.sort(function (a, b) { return a.label.localeCompare(b.label, 'zh-Hans-CN'); });
  const tools = '<label>设施 ' + selectHtml('f-station', stationOpts, stationFilter, '全部设施') + '</label>' +
    '<span class="muted">工具不计入成本 · 价格按 ' + escapeHtml(modeLabel()) + '</span>';
  renderList({
    tabId: 'craft', columns: columns, rows: rows, defaultSort: { key: 'perHour', dir: 'desc' },
    tools: tools, keyOf: function (r) { return r.key },
    emptyText: '没有匹配的配方。',
    wire: function (host) {
      const s = host.querySelector('#f-station');
      if (s) s.addEventListener('change', function () { state.filters.station = s.value; state.pages.craft = 1; render(); });
    },
  });
  hideDetail();
}

/* ---------- 7.7 交换 ---------- */

function renderBarter() {
  const mk = state.data.market || {};
  const q = state.q.trim().toLowerCase();
  const traderFilter = state.filters.trader;
  const traderSet = {};
  const rows = [];
  for (const b of mk.barters || []) {
    if (b.mode && b.mode !== state.mode) continue;
    traderSet[b.traderId] = 1;
    if (traderFilter && b.traderId !== traderFilter) continue;
    let cost = 0;
    const mats = [];
    for (const r of b.require || []) {
      const it = itemById(r.item);
      const unit = priceById(r.item, state.mode);
      cost += unit * (r.count || 0);
      mats.push({ name: it ? it.name : r.item, count: r.count, tool: false });
    }
    let value = 0;
    const rewards = [];
    for (const r of b.reward || []) {
      const it = itemById(r.item);
      const unit = priceById(r.item, state.mode);
      value += unit * (r.count || 0);
      rewards.push({ name: it ? it.name : r.item, count: r.count });
    }
    const profit = value - cost;
    const trader = traderName(b.traderId) || b.trader || '';
    const row = {
      key: b.id + '|' + (b.mode || 'regular'), rewards: rewards, mats: mats, cost: cost, value: value,
      profit: profit, trader: trader, traderId: b.traderId, level: b.level,
      seller: b.targetSellerPrice == null ? null : b.targetSellerPrice,
    };
    if (q) {
      let hit = matchText(trader, q);
      if (!hit) for (const m of mats) if (matchText(m.name, q)) { hit = true; break; }
      if (!hit) for (const r of rewards) if (matchText(r.name, q)) { hit = true; break; }
      if (!hit) continue;
    }
    rows.push(row);
  }
  const columns = [
    { key: 'reward', label: '换取物品', sortDir: 'asc', value: function (r) { return r.rewards.length ? r.rewards[0].name : ''; }, cell: function (r) { return namesText(r.rewards); } },
    { key: 'rewardCount', label: '数量', sortDir: 'desc', align: 'num', value: function (r) { return r.rewards.length ? r.rewards[0].count : null; }, cell: function (r) { return escapeHtml(countsText(r.rewards)); } },
    { key: 'mats', label: '所需材料', sortable: false, cell: function (r) { return matsText(r.mats); } },
    { key: 'trader', label: '商人', sortDir: 'asc', value: function (r) { return r.trader; }, cell: function (r) { return escapeHtml(r.trader); } },
    { key: 'level', label: '等级', sortDir: 'desc', align: 'num', value: function (r) { return r.level; }, cell: function (r) { return r.level == null ? '—' : 'Lv ' + r.level; } },
    { key: 'cost', label: '材料成本', sortDir: 'desc', align: 'num', value: function (r) { return r.cost; }, cell: function (r) { return rub(r.cost); } },
    { key: 'value', label: '目标价值(跳蚤)', sortDir: 'desc', align: 'num', value: function (r) { return r.value; }, cell: function (r) { return rub(r.value); } },
    { key: 'profit', label: '利润', sortDir: 'desc', align: 'num', value: function (r) { return r.profit; }, cell: function (r) { return '<span class="chg ' + (r.profit >= 0 ? 'up' : 'down') + '">' + rub(r.profit) + '</span>'; } },
  ];
  const traderOpts = Object.keys(traderSet).map(function (id) { return { value: id, label: traderName(id) }; });
  traderOpts.sort(function (a, b) { return a.label.localeCompare(b.label, 'zh-Hans-CN'); });
  const tools = '<label>商人 ' + selectHtml('f-trader', traderOpts, traderFilter, '全部商人') + '</label>' +
    '<span class="muted">按 ' + escapeHtml(modeLabel()) + ' 跳蚤价折算</span>';
  renderList({
    tabId: 'barter', columns: columns, rows: rows, defaultSort: { key: 'profit', dir: 'desc' },
    tools: tools, keyOf: function (r) { return r.key },
    emptyText: '没有匹配的交换配方。',
    wire: function (host) {
      const s = host.querySelector('#f-trader');
      if (s) s.addEventListener('change', function () { state.filters.trader = s.value; state.pages.barter = 1; render(); });
    },
  });
  hideDetail();
}

/* ---------- 7.8 倒卖 ---------- */

function renderResale() {
  const all = (state.data.economy && state.data.economy.items) || [];
  const q = state.q.trim().toLowerCase();
  const rows = [];
  for (const it of all) {
    if (q && !(matchText(it.name, q) || matchText(it.short, q) || matchText(it.id, q))) continue;
    const p = priceRec(it, state.mode);
    if (!p || p.last == null) continue;
    const buys = (p.buy || []).filter(function (x) { return x && x.p != null && x.p > 0; });
    if (!buys.length) continue;
    // "商人买入价" = 玩家从商人手里买的最低价，所以取 buy 里的最小值
    let best = buys[0];
    for (const x of buys) if (x.p < best.p) best = x;
    const profit = p.last - best.p;
    if (profit <= 0) continue;
    rows.push({
      key: it.id, it: it, name: it.name,
      trader: traderName(best.t), buy: best.p, flea: p.last, profit: profit,
      margin: best.p > 0 ? (profit / best.p) * 100 : null,
    });
  }
  const columns = [
    { key: 'name', label: '物品', sortDir: 'asc', value: function (r) { return r.name; }, cell: function (r) {
      return '<span class="cell-name">' + escapeHtml(r.name) + '</span><span class="cell-sub">' + escapeHtml(r.it.short || '') + '</span>';
    } },
    { key: 'trader', label: '买入商人', sortDir: 'asc', value: function (r) { return r.trader; }, cell: function (r) { return escapeHtml(r.trader); } },
    { key: 'buy', label: '买入价', sortDir: 'asc', align: 'num', value: function (r) { return r.buy; }, cell: function (r) { return rub(r.buy); } },
    { key: 'flea', label: '跳蚤价', sortDir: 'desc', align: 'num', value: function (r) { return r.flea; }, cell: function (r) { return rub(r.flea); } },
    { key: 'profit', label: '单件利润', sortDir: 'desc', align: 'num', value: function (r) { return r.profit; }, cell: function (r) { return '<span class="chg up">' + rub(r.profit) + '</span>'; } },
    { key: 'margin', label: '利润率', sortDir: 'desc', align: 'num', value: function (r) { return r.margin; }, cell: function (r) { return r.margin == null ? '—' : r.margin.toFixed(1) + '%'; } },
  ];
  renderList({
    tabId: 'resale', columns: columns, rows: rows, defaultSort: { key: 'profit', dir: 'desc' },
    limit: 300, keyOf: function (r) { return r.key },
    summary: '共 ' + num(rows.length) + ' 条可倒卖 · 按当前排序取前 300 条 · 价格按 ' + escapeHtml(modeLabel()),
    emptyText: '当前模式没有可倒卖的物品。',
  });
  hideDetail();
}

/* ---------- 7.9 BOSS ---------- */

function renderBoss() {
  const dump = state.data.bosses || {};
  const list = (dump.modes && (dump.modes[state.mode] || dump.modes.regular)) || [];
  const q = state.q.trim().toLowerCase();
  const rows = [];
  for (const b of list) {
    if (q && !(matchText(b.name, q) || matchText(b.normalizedName, q) || (b.mapNames || []).some(function (n) { return matchText(n, q); }))) continue;
    rows.push({
      key: b.id, b: b, name: b.name || b.normalizedName || b.id,
      max: b.maxSpawnChance, maps: b.maps || [], portrait: b.id + '.webp',
    });
  }
  const columns = [
    { key: 'portrait', label: '头像', sortable: false, width: '46px', cell: function (r) {
      return '<img class="thumb" loading="lazy" alt="" src="app://data/boss-portraits/' + escapeHtml(r.portrait) + '" />';
    } },
    { key: 'name', label: '中文名', sortDir: 'asc', value: function (r) { return r.name; }, cell: function (r) {
      return '<span class="cell-name">' + escapeHtml(r.name) + '</span><span class="cell-sub">' + escapeHtml(r.b.normalizedName || '') + '</span>';
    } },
    { key: 'max', label: '最高刷新率', sortDir: 'desc', align: 'num', value: function (r) { return r.max; }, cell: function (r) {
      return '<span class="boss-chance">' + pctInt(r.max) + '</span>';
    } },
    { key: 'maps', label: '各图刷新率', sortable: false, cell: function (r) {
      if (!r.maps.length) return '<span class="muted">无地图数据</span>';
      let html = '';
      for (const m of r.maps) {
        html += '<span class="tag">' + escapeHtml(m.mapName || m.mapKey || m.mapId) + ' <b>' + pctInt(m.spawnChance) + '</b></span>';
      }
      return html;
    } },
  ];
  renderList({
    tabId: 'boss', columns: columns, rows: rows, defaultSort: { key: 'max', dir: 'desc' },
    keyOf: function (r) { return r.key },
    summary: '共 ' + num(rows.length) + ' 个 BOSS（' + escapeHtml(modeLabel()) + ' 模式）· 刷新率是每局出现概率',
    emptyText: '当前模式没有 BOSS 数据。',
  });
  hideDetail();
}

/* ---------- 7.10 来源 ---------- */

function renderSource() {
  const host = $('#list-host');
  const d = state.data.economy || state.data.market || state.data.bosses;
  let html = '<div class="table-wrap" style="padding:14px 16px">';
  html += '<h4 style="color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:4px;margin-bottom:8px">数据来源与版权</h4>';
  html += '<div class="detail-note">物品 / 价格 / 任务 / BOSS 数据来自 tarkov.dev，中文任务资料来自 逃离塔科夫中文 Wiki；' +
    '游戏内名称、图标、头像等素材版权归 <b>Battlestate Games</b> 所有，仅供非商业的离线查询。</div>';
  html += '<div class="detail-note">数据时间：' + escapeHtml(d && d.fetchedAt ? fmtTime(d.fetchedAt) : '—') + '</div>';
  html += '<h4 style="color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:4px;margin:14px 0 8px">相关链接</h4>';
  html += '<div class="detail-actions" style="margin-top:0">';
  for (const l of SOURCE_LINKS) {
    html += '<button type="button" class="link-btn" data-act="open-url" data-url="' + escapeHtml(l.url) + '">' + escapeHtml(l.label) + '</button>';
  }
  html += '</div>';
  html += '</div>';
  host.innerHTML = html;
  hideDetail();
}

/* ---------- 7.11 收集清单（任务需求 + 藏身处需求） ---------- */

// 合并两类需求：
//   任务需求 = requirements-dump 的 modes[mode][itemId] = [{name, traderName, count, foundInRaid}]
//   藏身处需求 = market-dump 的 hideout.modules[].levels[].requirements[]
// 返回 Map<itemId, { tasks, taskCount, hideout, hideoutCount }>
function collectEntries() {
  const map = new Map();
  const get = function (id) {
    let e = map.get(id);
    if (!e) {
      e = { id: id, tasks: [], taskCount: 0, hideout: [], hideoutCount: 0 };
      map.set(id, e);
    }
    return e;
  };
  const req = state.data.requirements;
  const tasks = (req && req.modes && req.modes[state.mode]) || {};
  for (const itemId of Object.keys(tasks)) {
    const list = tasks[itemId] || [];
    const e = get(itemId);
    for (const t of list) {
      const c = toNum(t.count);
      e.taskCount += c == null ? 0 : c;
      e.tasks.push(t);
    }
  }
  for (const mod of hideoutModules()) {
    for (const lv of mod.levels || []) {
      for (const r of lv.requirements || []) {
        // 卢布是钱不是"要收集的物品"，混进来会多出一行"卢布 × 几百万"
        if (r.item === RUB_ID) continue;
        const e = get(r.item);
        const c = toNum(r.count);
        e.hideoutCount += c == null ? 0 : c;
        e.hideout.push({ module: hideoutName(mod), level: lv.level, count: c == null ? 0 : c });
      }
    }
  }
  return map;
}

function taskNamesText(tasks) {
  const names = [];
  for (const t of tasks) {
    const n = t && t.name ? String(t.name) : '';
    if (n && names.indexOf(n) < 0) names.push(n);
  }
  if (!names.length) return '';
  if (names.length <= 3) return names.join('、');
  return names.slice(0, 3).join('、') + ' 等 ' + names.length + ' 个';
}

function renderCollect() {
  const q = state.q.trim().toLowerCase();
  const rows = [];
  for (const e of collectEntries().values()) {
    const it = itemById(e.id);
    const name = it ? it.name : e.id;
    if (q && !(matchText(name, q) || (it && matchText(it.short, q)) || matchText(e.id, q))) continue;
    const total = e.taskCount + e.hideoutCount;
    const unit = fleaPrice(it, state.mode);
    rows.push({
      key: e.id, it: it, name: name,
      taskCount: e.taskCount, taskText: taskNamesText(e.tasks),
      hideoutCount: e.hideoutCount, total: total,
      unit: unit, subtotal: unit * total,
      collected: !!state.collect[e.id],
    });
  }
  let allValue = 0;
  let leftValue = 0;
  let done = 0;
  for (const r of rows) {
    allValue += r.subtotal;
    if (r.collected) done++;
    else leftValue += r.subtotal;
  }
  const columns = [
    { key: 'check', label: '', sortable: false, width: '30px', cell: function (r) {
      return '<input type="checkbox" data-act="check-collect" data-item="' + escapeHtml(r.key) + '"' + (r.collected ? ' checked' : '') + ' title="标记为已收集（会从剩余价值里扣掉）" />';
    } },
    { key: 'icon', label: '', sortable: false, width: '34px', cell: function (r) { return itemIconHtml(r.it); } },
    { key: 'name', label: '物品', sortDir: 'asc', value: function (r) { return r.name; }, cell: function (r) {
      return '<span class="cell-name">' + escapeHtml(r.name) + '</span><span class="cell-sub">' + escapeHtml(r.it && r.it.short ? r.it.short : '') + '</span>';
    } },
    { key: 'taskCount', label: '任务需要', sortDir: 'desc', align: 'num', value: function (r) { return r.taskCount; }, cell: function (r) { return r.taskCount ? countText(r.taskCount) : '<span class="muted">—</span>'; } },
    { key: 'taskText', label: '需要任务', sortable: false, cell: function (r) { return r.taskText ? escapeHtml(r.taskText) : '<span class="muted">—</span>'; } },
    { key: 'hideoutCount', label: '藏身处需要', sortDir: 'desc', align: 'num', value: function (r) { return r.hideoutCount; }, cell: function (r) { return r.hideoutCount ? countText(r.hideoutCount) : '<span class="muted">—</span>'; } },
    { key: 'total', label: '合计', sortDir: 'desc', align: 'num', value: function (r) { return r.total; }, cell: function (r) { return countText(r.total); } },
    { key: 'unit', label: '当前单价', sortDir: 'desc', align: 'num', value: function (r) { return r.unit; }, cell: function (r) { return rub(r.unit); } },
    { key: 'subtotal', label: '合计价值', sortDir: 'desc', align: 'num', value: function (r) { return r.subtotal; }, cell: function (r) { return rub(r.subtotal); } },
  ];
  const summary = '涉及物品 ' + num(rows.length) + ' 种 · 总价值 ' + rub(allValue) + ' · 已收集 ' + done + '/' + rows.length +
    ' · 剩余价值 ' + rub(leftValue) + ' · ' + escapeHtml(modeLabel()) + ' 价格';
  renderList({
    tabId: 'collect', columns: columns, rows: rows, defaultSort: { key: 'subtotal', dir: 'desc' },
    keyOf: function (r) { return r.key; }, selectedKey: state.sel.collect,
    summary: summary,
    emptyText: '没有匹配的收集物品。',
    onSelect: function (r) { state.sel.collect = r.key; showCollectDetail(r.key); },
  });
  if (state.sel.collect) showCollectDetail(state.sel.collect);
}

function setCollected(id, on) {
  if (on) state.collect[id] = true;
  else delete state.collect[id];
  saveCollect();
  // 勾选后只更新汇总数字，但简单起见整页重渲染；把表格滚动位置记回来，连续勾不会跳回顶部
  const wrap = $('#list-host').querySelector('.table-wrap');
  const top = wrap ? wrap.scrollTop : 0;
  const left = wrap ? wrap.scrollLeft : 0;
  render().then(function () {
    const w = $('#list-host').querySelector('.table-wrap');
    if (w) { w.scrollTop = top; w.scrollLeft = left; }
  });
}

function showCollectDetail(id) {
  const e = collectEntries().get(id);
  if (!e) { hideDetail(); return; }
  const it = itemById(id);
  const name = it ? it.name : id;
  const unit = fleaPrice(it, state.mode);
  const total = e.taskCount + e.hideoutCount;
  let html = '<div class="detail-title">' + itemIconHtml(it, 'big') +
    '<div><div class="detail-name">' + escapeHtml(name) + '</div>' +
    '<div class="detail-sub">' + escapeHtml(it && it.short ? it.short : '') + '</div>' +
    '<div class="detail-sub mono">' + escapeHtml(id) + '</div></div></div>';
  html += statGrid([
    ['任务需要', countText(e.taskCount)],
    ['藏身处需要', countText(e.hideoutCount)],
    ['合计', countText(total)],
    ['当前单价', rub(unit)],
    ['合计价值', rub(unit * total)],
    ['状态', state.collect[id] ? '已收集' : '未收集'],
  ]);
  html += '<h4>任务需求</h4>';
  if (!e.tasks.length) html += '<div class="detail-note">没有任务需要这件物品。</div>';
  else {
    html += '<table class="mini-table"><thead><tr><th>任务</th><th>商人</th><th class="num">数量</th><th>要求</th></tr></thead><tbody>';
    for (const t of e.tasks) {
      html += '<tr><td>' + escapeHtml(t.name || '') + '</td><td>' + escapeHtml(t.traderName || '—') + '</td>' +
        '<td class="num">' + countText(t.count) + '</td><td>' + (t.foundInRaid ? '需战局内找到' : '任意') + '</td></tr>';
    }
    html += '</tbody></table>';
  }
  html += '<h4>藏身处需求</h4>';
  if (!e.hideout.length) html += '<div class="detail-note">藏身处不需要这件物品。</div>';
  else {
    html += '<table class="mini-table"><thead><tr><th>模块</th><th>等级</th><th class="num">数量</th></tr></thead><tbody>';
    for (const h of e.hideout) {
      html += '<tr><td>' + escapeHtml(h.module) + '</td><td>Lv ' + h.level + '</td><td class="num">' + countText(h.count) + '</td></tr>';
    }
    html += '</tbody></table>';
  }
  showDetail(html);
}

/* ---------- 7.12 仪式圈（基准价达标、跳蚤成本最低的一维 DP） ---------- */

function nowMs() {
  try {
    if (typeof performance !== 'undefined' && performance && performance.now) return performance.now();
  } catch (e) { /* 没有 performance 就用 Date.now（老环境/测试 stub） */ }
  return Date.now();
}

// 把基准价按 1000 向下取整成"桶"：
//   floor 而不是 round/ceil 是为了让 sum(base) >= sum(bucket)*1000 恒成立，
//   这样只要桶和 >= ceil(阈值/1000)，真实基准价合计就一定达标（不达标就是算错）。
// 每件物品最多买 limit 件 => 一维多重背包 + 最小成本，用单调队列把"上一件物品"的转移压到 O(桶数)。
// 候选先做现实性过滤（否则 DP 会去捡 1 ₽ 的孤品挂单，结果看着像 bug）：
//   - 当前价 < 基准价 10% 的丢掉；
//   - 报价数 offers 有值且 < 5 的丢掉。
function computeRitual(threshold, mode, perItemLimit) {
  const t0 = nowMs();
  const lim = toNum(perItemLimit);
  const limit = Math.max(1, Math.min(50, lim == null ? 5 : Math.round(lim)));
  const all = (state.data.economy && state.data.economy.items) || [];
  const list = [];
  let skipPrice = 0;
  let skipOffers = 0;
  for (const it of all) {
    const q = priceRec(it, mode);
    if (!q || q.base == null || q.base <= 0) continue;
    const cost = fleaPrice(it, mode);
    if (!(cost > 0)) continue;
    if (cost < q.base * 0.10) { skipPrice++; continue; }
    if (q.offers != null && q.offers < 5) { skipOffers++; continue; }
    const bucket = Math.floor(q.base / 1000);
    if (bucket < 1) continue;
    list.push({ id: it.id, name: it.name, icon: it.icon, base: q.base, cost: cost, bucket: bucket, offers: q.offers == null ? null : q.offers });
  }
  const targetBuckets = Math.ceil(threshold / 1000);
  const cap = targetBuckets + 26;   // +26 桶的余量：允许略微冲高，换更便宜的方案
  const n = list.length;
  const W = cap + 1;
  let dp = new Float64Array(W);     // 只考虑前 i 件时的最小成本（按桶和）
  let ndp = new Float64Array(W);    // 加上第 i 件之后
  for (let b = 0; b < W; b++) dp[b] = Infinity;
  dp[0] = 0;
  // cntAll[i*W+b] = 只考虑前 i 件时，达到桶和 b 用了第 i 件几件（回溯用；limit <= 50 装得进 Int8）
  const cntAll = new Int8Array(n * W);
  const deqIdx = new Int32Array(W);  // 单调队列：桶序号 k
  const deqVal = new Float64Array(W);
  for (let i = 0; i < n; i++) {
    const w = list[i].bucket;
    const c = list[i].cost;
    ndp.set(dp);
    const row = i * W;
    if (w <= cap) {
      for (let r = 0; r < w; r++) {
        let head = 0;
        let tail = 0;
        for (let k = 0; r + k * w <= cap; k++) {
          const b = r + k * w;
          const val = dp[b] - k * c;
          while (tail > head && deqVal[tail - 1] >= val) tail--;
          deqIdx[tail] = k;
          deqVal[tail] = val;
          tail++;
          const minJ = k - limit;
          while (tail > head && deqIdx[head] < minJ) head++;
          if (tail > head) {
            const cand = deqVal[head] + k * c;
            if (cand < ndp[b]) {
              ndp[b] = cand;
              cntAll[row + b] = k - deqIdx[head];
            }
          }
        }
      }
    }
    const tmp = dp;
    dp = ndp;
    ndp = tmp;
  }
  let bestB = -1;
  let bestCost = Infinity;
  for (let b = targetBuckets; b <= cap; b++) {
    if (dp[b] < bestCost) { bestCost = dp[b]; bestB = b; }
  }
  const counts = new Map();
  if (bestB >= 0 && isFinite(bestCost)) {
    let b = bestB;
    for (let i = n - 1; i >= 0; i--) {
      const k = cntAll[i * W + b];
      if (k > 0) {
        counts.set(i, k);
        b -= k * list[i].bucket;
      }
    }
  }
  // 单件基准价就够阈值、但桶数超出 DP 窗口的物品也参与比较（否则会漏掉"一件顶十件"的贵件）
  let singleIdx = -1;
  let singleCost = Infinity;
  for (let i = 0; i < n; i++) {
    if (list[i].base >= threshold && list[i].cost < singleCost) { singleCost = list[i].cost; singleIdx = i; }
  }
  if (singleIdx >= 0 && (!counts.size || singleCost < bestCost)) {
    counts.clear();
    counts.set(singleIdx, 1);
    bestCost = singleCost;
  }
  const rows = [];
  let baseSum = 0;
  let costSum = 0;
  let qty = 0;
  counts.forEach(function (c, i) {
    const it = list[i];
    const sub = it.cost * c;
    baseSum += it.base * c;
    costSum += sub;
    qty += c;
    rows.push({
      key: it.id + '#' + i, id: it.id, name: it.name, icon: it.icon,
      qty: c, unit: it.cost, subtotal: sub, base: it.base, baseSubtotal: it.base * c,
    });
  });
  return {
    threshold: threshold, limit: limit, items: rows, baseSum: baseSum, costSum: costSum, qty: qty,
    over: baseSum - threshold, ms: nowMs() - t0, candidates: list.length,
    skipPrice: skipPrice, skipOffers: skipOffers, noSolution: counts.size === 0,
  };
}

function scheduleRitual(key) {
  if (state.ritual.pending === key) return;
  state.ritual.pending = key;
  // 放到下一个 tick：先把"计算中…"刷到屏幕上，DP 再阻塞也看得见
  setTimeout(function () {
    state.ritual.pending = null;
    let plan = null;
    try {
      plan = computeRitual(state.ritual.threshold, state.mode, state.ritual.limit);
    } catch (e) {
      console.error('[资料库] 仪式圈计算失败', e);
      plan = { error: true, items: [], baseSum: 0, costSum: 0, qty: 0, over: 0, ms: 0, threshold: state.ritual.threshold,
        limit: state.ritual.limit, candidates: 0, skipPrice: 0, skipOffers: 0, noSolution: true };
    }
    state.ritual.plan = plan;
    state.ritual.planFor = key;
    if (state.tab === 'ritual') render();
  }, 0);
}

// 阈值/每件上限一变就丢掉缓存，下一次渲染重新排 DP
function setRitualThreshold(v) {
  const n = Math.max(10000, Math.min(2000000, Math.round(Number(v) || 400000)));
  if (n === state.ritual.threshold) return;
  state.ritual.threshold = n;
  state.ritual.plan = null;
  state.ritual.planFor = null;
  render();
}
function setRitualLimit(v) {
  const n = Math.max(1, Math.min(50, Math.round(Number(v) || 5)));
  if (n === state.ritual.limit) return;
  state.ritual.limit = n;
  state.ritual.plan = null;
  state.ritual.planFor = null;
  render();
}

const RITUAL_COLUMNS = [
  { key: 'icon', label: '', sortable: false, width: '34px', cell: function (r) { return itemIconHtml(r); } },
  { key: 'name', label: '物品', sortDir: 'asc', value: function (r) { return r.name; }, cell: function (r) {
    return '<span class="cell-name">' + escapeHtml(r.name) + '</span>';
  } },
  { key: 'qty', label: '数量', sortDir: 'desc', align: 'num', value: function (r) { return r.qty; }, cell: function (r) { return num(r.qty); } },
  { key: 'unit', label: '跳蚤单价', sortDir: 'asc', align: 'num', value: function (r) { return r.unit; }, cell: function (r) { return rub(r.unit); } },
  { key: 'subtotal', label: '跳蚤小计', sortDir: 'desc', align: 'num', value: function (r) { return r.subtotal; }, cell: function (r) { return rub(r.subtotal); } },
  { key: 'base', label: '基准价单价', sortDir: 'asc', align: 'num', value: function (r) { return r.base; }, cell: function (r) { return rub(r.base); } },
  { key: 'baseSubtotal', label: '基准价小计', sortDir: 'desc', align: 'num', value: function (r) { return r.baseSubtotal; }, cell: function (r) { return rub(r.baseSubtotal); } },
];

function renderRitual() {
  const key = state.ritual.threshold + '|' + state.ritual.limit + '|' + state.mode;
  if (state.ritual.plan && state.ritual.planFor === key) { renderRitualView(state.ritual.plan); return; }
  if (state.ritual.planFor !== key) scheduleRitual(key);
  renderRitualView(null);
}

function renderRitualView(plan) {
  const th = state.ritual.threshold;
  const limit = state.ritual.limit;
  const q = state.q.trim().toLowerCase();
  const tools = '<div class="ritual-head">' +
    '<label>献祭阈值 <input type="number" id="ritual-num" min="10000" max="2000000" step="1000" value="' + th + '" /> ₽</label>' +
    '<input type="range" id="ritual-range" min="10000" max="2000000" step="1000" value="' + th + '" title="拖动后松手才会重算" />' +
    '<label>每件上限 <input type="number" id="ritual-limit" min="1" max="50" step="1" value="' + limit + '" title="同一件物品最多买几件" /> 件</label>' +
    '<button type="button" data-act="ritual-preset" data-value="350001">350,001</button>' +
    '<button type="button" data-act="ritual-preset" data-value="400000">400,000</button>' +
    '<span class="muted">已排除异常挂单</span>' +
    '</div>';
  let summary;
  const rows = [];
  if (!plan) {
    summary = '<span class="computing">计算中…</span>';
  } else if (plan.error) {
    summary = '计算出错了，换个阈值或模式再试。';
  } else if (plan.noSolution) {
    summary = '<span class="chg down">当前约束下凑不到这个阈值，试试降低阈值或放宽每件上限。</span>';
  } else {
    summary = '基准价合计 <b>' + rub(plan.baseSum) + '</b>（比阈值高 ' + rub(plan.over) + '）· 跳蚤成本合计 <b>' + rub(plan.costSum) +
      '</b> · 物品 ' + num(plan.qty) + ' 件 / ' + num(plan.items.length) + ' 种 · ' + escapeHtml(modeLabel()) + ' 价格';
    for (const r of plan.items) {
      if (q && !matchText(r.name, q)) continue;
      rows.push(r);
    }
  }
  renderList({
    tabId: 'ritual', columns: RITUAL_COLUMNS, rows: rows, defaultSort: { key: 'subtotal', dir: 'desc' },
    tools: tools, summary: summary, keyOf: function (r) { return r.key; },
    emptyText: plan
      ? (plan.error ? '计算失败。' : (plan.noSolution ? '当前约束下凑不到这个阈值，试试降低阈值或放宽每件上限。' : '没有匹配的物品。'))
      : '计算中…',
    wire: function (host) {
      const numEl = host.querySelector('#ritual-num');
      const rangeEl = host.querySelector('#ritual-range');
      const limitEl = host.querySelector('#ritual-limit');
      if (numEl) numEl.addEventListener('change', function () { setRitualThreshold(numEl.value); });
      if (rangeEl) {
        // 拖动时只同步数字框，松手（change）才重算：否则每动一下都重渲染，滑块会"断"
        rangeEl.addEventListener('input', function () { if (numEl) numEl.value = rangeEl.value; });
        rangeEl.addEventListener('change', function () { setRitualThreshold(rangeEl.value); });
      }
      if (limitEl) limitEl.addEventListener('change', function () { setRitualLimit(limitEl.value); });
    },
  });
  hideDetail();
}

/* ---------- 7.13 特质（赛季特质模拟器） ---------- */

function traitList() { return (state.data.traits && state.data.traits.traits) || []; }
function traitById(id) {
  for (const t of traitList()) if (t.id === id) return t;
  return null;
}
function traitSelected(id) { return state.traits.selected.indexOf(id) >= 0; }
// 冲突是双向的：A.conflicts 里有 B，或 B.conflicts 里有 A，都算冲突。
// 返回"与哪一项已选特质冲突"的名字，没有冲突返回 null。
function traitConflict(t) {
  for (const id of state.traits.selected) {
    if (id === t.id) continue;
    const sel = traitById(id);
    if (!sel) continue;
    if ((t.conflicts || []).indexOf(id) >= 0) return sel.name || id;
    if ((sel.conflicts || []).indexOf(t.id) >= 0) return sel.name || id;
  }
  return null;
}
function traitPoints(cat) {
  let sum = 0;
  for (const t of traitList()) {
    if (t.category !== cat || !traitSelected(t.id)) continue;
    const p = toNum(t.points);
    sum += p == null ? 0 : p;
  }
  return sum;
}
function toggleTrait(id) {
  const t = traitById(id);
  if (!t) return;
  if (traitSelected(id)) {
    state.traits.selected = state.traits.selected.filter(function (x) { return x !== id; });
  } else {
    if (traitConflict(t)) return;   // 置灰的卡片点了不生效
    state.traits.selected = state.traits.selected.concat([id]);
  }
  saveTraitsState();
  renderKeepPageScroll();
}

function renderKeepPageScroll() {
  const host = $('#list-host');
  const sc = host.querySelector('.page-scroll, .table-wrap');
  const top = sc ? sc.scrollTop : 0;
  render().then(function () {
    const sc2 = $('#list-host').querySelector('.page-scroll, .table-wrap');
    if (sc2) sc2.scrollTop = top;
  });
}

function renderTraitSection(title, cat, q) {
  let cards = '';
  let count = 0;
  for (const t of traitList()) {
    if (t.category !== cat) continue;
    if (q && !matchText(t.name, q)) continue;
    count++;
    const selected = traitSelected(t.id);
    const conflict = selected ? null : traitConflict(t);
    const cls = 'trait-card' + (selected ? ' selected' : '') + (conflict ? ' blocked' : '');
    cards += '<button type="button" class="' + cls + '" data-act="toggle-trait" data-id="' + escapeHtml(t.id) + '"' +
      (conflict ? ' title="与「' + escapeHtml(conflict) + '」冲突：先取消那一个"' : '') + '>' +
      '<span class="trait-name">' + escapeHtml(t.name) + '</span>' +
      '<span class="trait-points">' + (toNum(t.points) == null ? '—' : t.points) + ' 点</span>' +
      (selected ? '<span class="trait-tag">已选</span>' : '') +
      (conflict ? '<span class="trait-tag warn">与 ' + escapeHtml(conflict) + ' 冲突</span>' : '') +
      '</button>';
  }
  let html = '<h4 class="trait-title">' + escapeHtml(title) + '</h4><div class="trait-grid">' + cards + '</div>';
  if (!count) html += '<div class="detail-note">没有匹配的特质。</div>';
  return html;
}

function renderTraits() {
  const q = state.q.trim().toLowerCase();
  const pos = traitPoints('positive');
  const neg = traitPoints('negative');
  const budget = state.traits.budget;
  // 负向特质是"用缺点换点数"，所以它给预算加回点数；正向扣点数。
  const remainder = budget - pos + neg;
  const over = remainder < 0;
  let html = '<div class="page-scroll"><div class="trait-head">' +
    '<span>已选 <b>' + state.traits.selected.length + '</b> 个</span>' +
    '<span>正向点数 <b class="up">' + pos + '</b></span>' +
    '<span>负向点数 <b class="down">' + neg + '</b></span>' +
    '<span>剩余可支配 <b class="' + (over ? 'down' : '') + '">' + remainder + '</b></span>' +
    '<label>点数预算 <input type="number" id="trait-budget" min="0" max="999" step="1" value="' + budget + '" /></label>' +
    '<button type="button" data-act="clear-traits">清空选择</button>' +
    '</div>';
  if (over) html += '<div class="trait-warn">正向点数已超出预算 ' + Math.abs(remainder) + ' 点（仍可继续选择）。</div>';
  html += renderTraitSection('正向特质', 'positive', q);
  html += renderTraitSection('负向特质', 'negative', q);
  html += '</div>';
  const host = $('#list-host');
  host.innerHTML = html;
  wireImages(host);
  hideDetail();
  const b = host.querySelector('#trait-budget');
  if (b) b.addEventListener('change', function () {
    const v = toNum(b.value);
    state.traits.budget = v == null ? 20 : Math.max(0, Math.round(v));
    saveTraitsState();
    renderKeepPageScroll();
  });
}

/* ---------- 7.14 BTR 路线与站点 ---------- */

const BTR_STOP_TOL = 300; // 站点到路线路径点最近距离 <= 300 像素就算"这条路线经过这一站"

function btrGroupName(map, key) {
  for (const g of map.groups || []) if (g.key === key) return g.name || key;
  return key || '—';
}
function btrRouteStops(map, route, tol) {
  let n = 0;
  for (const s of map.stops || []) {
    let best = Infinity;
    for (const p of route.path || []) {
      const dx = p.x - s.x;
      const dy = p.y - s.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) best = d;
      if (best <= tol) break;
    }
    if (best <= tol) n++;
  }
  return n;
}
// 秒 -> "第 30 分 42 秒"
function clockText(sec) {
  const s = toNum(sec);
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return '第 ' + m + ' 分 ' + (r < 10 ? '0' + r : r) + ' 秒';
}

const BTR_COLUMNS = [
  { key: 'name', label: '路线名', sortDir: 'asc', value: function (r) { return r.name; }, cell: function (r) { return escapeHtml(r.name); } },
  { key: 'group', label: '分组', sortDir: 'asc', value: function (r) { return r.group; }, cell: function (r) { return escapeHtml(r.group); } },
  { key: 'spawnTime', label: '出现时刻', sortDir: 'asc', value: function (r) { return r.spawnTime; }, cell: function (r) { return escapeHtml(clockText(r.spawnTime)); } },
  { key: 'stops', label: '途经站点数', title: '估算：站点到路线路径点最近距离 ≤ ' + BTR_STOP_TOL + ' 像素即算经过', sortDir: 'desc', align: 'num', value: function (r) { return r.stops; }, cell: function (r) { return num(r.stops); } },
  { key: 'loop', label: '完整一圈耗时', title: '估算：站点数 × 每站停靠时长，不含行驶时间', sortDir: 'asc', align: 'num', value: function (r) { return r.loop; }, cell: function (r) { return r.loop == null ? '—' : escapeHtml(fmtDuration(r.loop)); } },
];
const BTR_DIR = { name: 'asc', group: 'asc', spawnTime: 'asc', stops: 'desc', loop: 'asc' };

function renderBtr() {
  const dump = state.data.btr || {};
  const maps = dump.maps || [];
  const q = state.q.trim().toLowerCase();
  const sort = state.btrSort || { key: 'spawnTime', dir: 'asc' };
  const host = $('#list-host');
  let totalRoutes = 0;
  let totalStops = 0;
  for (const m of maps) { totalRoutes += (m.routes || []).length; totalStops += (m.stops || []).length; }
  let html = '<div class="page-scroll">';
  html += '<div class="list-summary">' + num(maps.length) + ' 张地图 · ' + num(totalRoutes) + ' 条路线 · ' + num(totalStops) +
    ' 个站点' + (dump.version ? ' · 数据版本 v' + escapeHtml(String(dump.version)) : '') + '</div>';

  for (const m of maps) {
    const mapHit = !q || matchText(m.name, q) || matchText(m.key, q);
    const stopsAll = m.stops || [];
    const routes = [];
    for (const rt of m.routes || []) {
      const group = btrGroupName(m, rt.group);
      if (q && !mapHit && !matchText(rt.name, q) && !matchText(group, q)) continue;
      const stops = btrRouteStops(m, rt, BTR_STOP_TOL);
      routes.push({
        key: m.key + '|' + rt.id, route: rt, id: rt.id, name: rt.name || rt.id, group: group,
        spawnTime: rt.spawnTime, stops: stops,
        loop: toNum(m.stopDuration) == null ? null : stops * m.stopDuration,
      });
    }
    const stops = stopsAll.filter(function (s) { return mapHit || matchText(s.name, q); });
    if (q && !mapHit && !routes.length && !stops.length) continue;

    html += '<section class="btr-map">';
    html += '<div class="btr-head"><span class="btr-title">' + escapeHtml(m.name || m.key) + '</span>' +
      '<span class="tag">整局 <b>' + escapeHtml(fmtDuration(m.raidDuration)) + '</b></span>' +
      '<span class="tag">刷新率 <b>' + (toNum(m.spawnChance) == null ? '—' : m.spawnChance + '%') + '</b></span>' +
      '<span class="tag">每站停靠 <b>' + escapeHtml(fmtDuration(m.stopDuration)) + '</b></span>' +
      '<span class="tag">' + num(stopsAll.length) + ' 站 / ' + num((m.routes || []).length) + ' 条路线</span></div>';

    const sorted = sortRows(routes, sort, BTR_COLUMNS);
    html += '<div class="table-wrap btr-table"><table class="lib-table"><thead><tr>';
    for (const c of BTR_COLUMNS) {
      const active = sort.key === c.key;
      html += '<th class="' + (c.align === 'num' ? 'num ' : '') + 'sortable' + (active ? ' active' : '') +
        '" data-btr-sort="' + escapeHtml(c.key) + '"' + (c.title ? ' title="' + escapeHtml(c.title) + '"' : '') + '>' +
        escapeHtml(c.label) + (active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '') + '</th>';
    }
    html += '</tr></thead><tbody>';
    if (!sorted.length) html += '<tr class="empty-row"><td colspan="' + BTR_COLUMNS.length + '">没有匹配的路线。</td></tr>';
    for (const r of sorted) {
      const isSel = state.sel.btr === r.key;
      html += '<tr tabindex="0"' + (isSel ? ' class="selected"' : '') + ' data-btr-route="' + escapeHtml(r.route.id) + '" data-btr-map="' + escapeHtml(m.key) + '">';
      for (const c of BTR_COLUMNS) html += '<td class="' + (c.align === 'num' ? 'num' : '') + '">' + c.cell(r) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';

    html += '<div class="btr-stops">';
    if (!stops.length) html += '<span class="muted">没有匹配的站点。</span>';
    for (const s of stops) html += '<span class="tag">' + escapeHtml(s.name || s.id) + ' <b>' + num(s.x) + ', ' + num(s.y) + '</b></span>';
    html += '</div></section>';
  }
  html += '</div>';
  host.innerHTML = html;

  for (const th of host.querySelectorAll('th[data-btr-sort]')) {
    th.addEventListener('click', function () {
      const k = th.getAttribute('data-btr-sort');
      if (sort.key === k) state.btrSort = { key: k, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
      else state.btrSort = { key: k, dir: BTR_DIR[k] || 'asc' };
      render();
    });
  }
  for (const tr of host.querySelectorAll('tr[data-btr-route]')) {
    const pick = function () { showBtrDetail(tr.getAttribute('data-btr-map'), tr.getAttribute('data-btr-route')); };
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
  }
  wireImages(host);
  if (state.sel.btr) {
    const parts = String(state.sel.btr).split('|');
    showBtrDetail(parts[0], parts[1]);
  } else {
    hideDetail();
  }
}

function showBtrDetail(mapKey, routeId) {
  const maps = (state.data.btr && state.data.btr.maps) || [];
  let map = null;
  let route = null;
  for (const m of maps) {
    if (m.key !== mapKey) continue;
    map = m;
    for (const rt of m.routes || []) if (rt.id === routeId) route = rt;
  }
  if (!map || !route) { hideDetail(); return; }
  state.sel.btr = mapKey + '|' + routeId;
  const stops = btrRouteStops(map, route, BTR_STOP_TOL);
  const stopDur = toNum(map.stopDuration);
  const loop = stopDur == null ? null : stops * stopDur;
  let html = '<div class="detail-title"><div><div class="detail-name">' + escapeHtml(map.name || map.key) + ' · ' + escapeHtml(route.name || route.id) + '</div>' +
    '<div class="detail-sub">分组 ' + escapeHtml(btrGroupName(map, route.group)) + ' · 出现时刻 ' + escapeHtml(clockText(route.spawnTime)) + '</div>' +
    '<div class="detail-sub mono">' + escapeHtml(route.id) + '</div></div></div>';
  html += statGrid([
    ['沿线站点数', num(stops) + '（估算）'],
    ['完整一圈耗时', loop == null ? '—' : escapeHtml(fmtDuration(loop)) + '（估算）'],
  ]);
  html += '<div class="detail-note">一圈耗时按站点数 × 每站停靠时长估算，不含行驶时间。</div>';
  showDetail(html);
}

/* ===========================================================================
 * 8. 顶栏 / 事件 / 初始化
 * =========================================================================== */

function paintTabs() {
  const nav = $('#tabs');
  if (!nav.dataset.built) {
    let html = '';
    for (const t of TABS) html += '<button type="button" class="tab" data-tab="' + escapeHtml(t.id) + '">' + escapeHtml(t.label) + '</button>';
    nav.innerHTML = html;
    nav.dataset.built = '1';
    nav.addEventListener('click', function (e) {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      switchTab(b.getAttribute('data-tab'));
      b.blur();
    });
  }
  for (const b of nav.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.getAttribute('data-tab') === state.tab);
}

function paintMode() {
  for (const b of $('#mode-switch').querySelectorAll('[data-mode]')) {
    b.classList.toggle('active', b.getAttribute('data-mode') === state.mode);
  }
}

function paintDataTime() {
  const d = state.data.economy || state.data.market || state.data.bosses || state.data.taskGuides;
  $('#data-time').textContent = '数据时间: ' + (d && d.fetchedAt ? fmtTime(d.fetchedAt) : '-');
}

function switchTab(id) {
  if (!TABS.some(function (t) { return t.id === id; })) return;
  if (state.tab !== id) {
    state.tab = id;
    state.pages[id] = state.pages[id] || 1;
    // 切页签时详情面板收起：不同页签的选中项不是一回事
    const d = $('#detail');
    d.classList.add('hidden');
    d.innerHTML = '';
  }
  render();
}

function setMode(mode) {
  if (mode !== 'regular' && mode !== 'pve') return;
  if (state.mode === mode) return;
  state.mode = mode;
  lsSet(LS_MODE, mode);
  paintMode();
  render();
}

function applyGoto(o) {
  if (o.tab && TABS.some(function (t) { return t.id === o.tab; })) {
    state.tab = o.tab;
    state.pages[o.tab] = 1;
  }
  if (o.id) selectById(o.id);
}
function selectById(id) {
  const econ = state.data.economy;
  if (!econ) return;
  let tab = null;
  if ((econ.items || []).some(function (x) { return x.id === id; })) tab = 'items';
  else if ((econ.ammo || []).some(function (x) { return x.id === id; })) tab = 'ammo';
  else if ((econ.gear || []).some(function (x) { return x.id === id; })) tab = 'gear';
  else if ((econ.keys || []).some(function (x) { return x.id === id; })) tab = 'keys';
  if (!tab) return;
  state.tab = tab;
  state.sel[tab] = id;
  state.pages[tab] = 1;
}
function onGoto(o) {
  if (!o) return;
  // 窗口刚打开时 economy 还没到，先记下来，等它加载完再跳（见 ensureDump）
  if (o.id && !state.data.economy) pendingGoto = o;
  else applyGoto(o);
  render();
}

function wireChrome() {
  const ms = $('#mode-switch');
  ms.addEventListener('click', function (e) {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    setMode(b.getAttribute('data-mode'));
    b.blur();
  });

  const q = $('#q');
  const later = debounce(function () {
    state.q = q.value;
    state.pages[state.tab] = 1;
    render();
  }, 200);
  q.addEventListener('input', later);
  q.addEventListener('search', function () {
    state.q = q.value;
    state.pages[state.tab] = 1;
    render();
  });

  // 详情/藏身处/外链等都用 data-act 委托，innerHTML 换来换去也不用重新绑定
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.getAttribute('data-act');
    if (act === 'close-detail') hideDetail();
    else if (act === 'open-url') {
      e.preventDefault();
      api.openExternal(el.getAttribute('data-url'));
    } else if (act === 'toggle-level') {
      toggleHideoutLevel(el.getAttribute('data-module'), Number(el.getAttribute('data-level')));
    } else if (act === 'check-collect') {
      e.stopPropagation();   // 勾选不要冒泡到行上（行点击 = 打开详情）
    } else if (act === 'toggle-trait') {
      toggleTrait(el.getAttribute('data-id'));
    } else if (act === 'clear-traits') {
      state.traits.selected = [];
      saveTraitsState();
      renderKeepPageScroll();
    } else if (act === 'ritual-preset') {
      setRitualThreshold(Number(el.getAttribute('data-value')));
    }
  });
  document.addEventListener('change', function (e) {
    const hi = e.target.closest('[data-act="check-item"]');
    if (hi) {
      checkHideoutItem(hi.getAttribute('data-module'), Number(hi.getAttribute('data-level')), hi.getAttribute('data-item'), hi.checked);
      return;
    }
    const co = e.target.closest('[data-act="check-collect"]');
    if (co) setCollected(co.getAttribute('data-item'), co.checked);
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hideDetail();
  });

  api.onLibraryGoto(onGoto);
}

function showMissing(key, tab) {
  $('#list-host').innerHTML = '<div class="placeholder">「' + escapeHtml(tab.label) +
    '」页签的数据缺失，暂时不可用；其它页签不受影响。</div>';
  hideDetail();
}

async function render() {
  const seq = ++renderSeq;
  let tab = TABS.filter(function (t) { return t.id === state.tab; })[0] || TABS[0];
  paintTabs();
  paintMode();
  paintDataTime();
  $('#q').placeholder = tab.ph || '搜索…';

  const host = $('#list-host');
  let loading = false;
  for (const key of tab.dumps) if (!state.data[key] && !state.loadErr[key]) loading = true;
  if (loading) host.innerHTML = '<div class="placeholder">正在加载数据…</div>';

  for (const key of tab.dumps) {
    await ensureDump(key);
    if (seq !== renderSeq) return;   // 加载期间用户又切了页签 / 换了模式，这次渲染作废
  }
  paintDataTime();
  // 加载期间 goto 可能把页签换掉了，重新取一次
  tab = TABS.filter(function (t) { return t.id === state.tab; })[0] || tab;
  paintTabs();
  $('#q').placeholder = tab.ph || '搜索…';

  for (const key of tab.dumps) {
    if (!state.data[key]) { showMissing(key, tab); return; }
  }
  try {
    renderTab(tab);
  } catch (e) {
    console.error('[资料库] 页签渲染失败', e);
    host.innerHTML = '<div class="placeholder">这个页签渲染出错了，其它页签仍然可用。</div>';
    hideDetail();
  }
}

async function init() {
  // 初始模式：用户上次的手动选择优先；没有记录则用主进程判定的当前游戏模式
  const saved = lsGet(LS_MODE, null);
  if (saved === 'pve' || saved === 'regular') state.mode = saved;
  try {
    const st = await api.getState();
    if (!saved && st && (st.gameMode === 'pve' || st.gameMode === 'regular')) state.mode = st.gameMode;
  } catch (e) {
    console.warn('[资料库] 读取当前游戏模式失败，按 PVP 显示', e);
  }
  loadHideoutState();
  loadCollect();
  loadTraitsState();
  wireChrome();
  render();
}

init();
