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
  { id: 'items', label: '物品', dumps: ['economy'], ph: '搜索物品中文名 / 短名 / id' },
  { id: 'ammo', label: '弹药', dumps: ['economy'], ph: '搜索弹药名称 / 短名' },
  { id: 'gear', label: '防具', dumps: ['economy'], ph: '搜索防具名称 / 短名' },
  { id: 'keys', label: '钥匙', dumps: ['economy'], ph: '搜索钥匙名称 / 短名' },
  { id: 'hideout', label: '藏身处', dumps: ['economy', 'market'], ph: '搜索藏身处模块' },
  { id: 'craft', label: '制作', dumps: ['economy', 'market'], ph: '搜索产出物 / 材料 / 设施' },
  { id: 'barter', label: '交换', dumps: ['economy', 'market'], ph: '搜索换取物品 / 材料 / 商人' },
  { id: 'resale', label: '倒卖', dumps: ['economy'], ph: '搜索物品名称' },
  { id: 'boss', label: 'BOSS', dumps: ['bosses'], ph: '搜索 BOSS 名称 / 地图' },
  { id: 'source', label: '来源', dumps: ['economy', 'market', 'bosses', 'taskGuides'], ph: '来源页无需搜索' },
];

const DUMPS = {
  // script = 缺数据时告诉用户跑哪条命令（tools/fetch-*.js，见 README"数据更新"一节）
  economy: { file: 'economy-dump.json', script: 'npm run fetch:economy' },
  market: { file: 'market-dump.json', script: 'npm run fetch:market' },
  bosses: { file: 'bosses-dump.json', script: 'npm run fetch:bosses' },
  taskGuides: { file: 'task-guides.json', script: 'npm run fetch:guides' },
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
  { label: 'tarkov.dev（物品 / 价格数据源）', url: 'https://tarkov.dev' },
  { label: '逃离塔科夫中文 Wiki（任务攻略 / 截图 / 物品 Wiki）', url: 'https://www.eftarkov.com' },
  { label: 'kaedeori 中文站（BOSS 刷新数据整理）', url: 'https://member.kaedeori.com/api/tarkov/boss/list' },
  { label: 'Battlestate Games（游戏官网，素材版权方）', url: 'https://www.escapefromtarkov.com' },
];

const LS_MODE = 'tarkov-lib-mode';
const LS_HIDEOUT = 'tarkov-lib-hideout-v1';
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
  html += '<div class="detail-note">上游更新时间：' + escapeHtml(fmtTime(q.updated)) + ' · 扫描时间：' + escapeHtml(fmtTime(q.scan)) + '</div>';
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
      tr.addEventListener('click', pick);
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
    case 'boss': renderBoss(); break;
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
  const tools = '<label>分类 ' + selectHtml('f-category', handbookCategoryOptions(), cat, '全部分类') + '</label>' +
    '<span class="muted">每格价值 = 当前跳蚤价 ÷ 格数</span>';
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
      if (r.base != null) return '<span class="muted" title="上游没有跳蚤成交价，这里显示基准价">' + rub(r.base) + ' *</span>';
      return '—';
    } },
    { key: 'best', label: '最好的商人收购', sortDir: 'desc', align: 'num', value: function (r) { return r.best; }, cell: function (r) { return rub(r.best); } },
  ];
  const tools = '<label>口径 ' + selectHtml('f-caliber', ammoCaliberOptions(all), cal, '全部口径') + '</label>' +
    (noFlea ? '<span class="muted">带 * 的是基准价（上游这批弹药没有跳蚤成交数据）</span>' : '');
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
    '<span class="muted">工具不消耗，已排除在材料成本外 · 价格按 ' + escapeHtml(modeLabel()) + '</span>';
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
    '<span class="muted">成本/价值按 ' + escapeHtml(modeLabel()) + ' 跳蚤价折算，卢布按面值</span>';
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
    summary: '共 ' + num(rows.length) + ' 条可倒卖（商人买入价 < 跳蚤当前价），按当前排序取前 300 条 · 价格按 ' + escapeHtml(modeLabel()),
    emptyText: '当前模式没有可倒卖的物品（商人买入价都不低于跳蚤价）。',
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
  let html = '<div class="table-wrap" style="padding:14px 16px">';
  html += '<h4 style="color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:4px;margin-bottom:8px">数据来源与版权</h4>';
  html += '<div class="detail-note">本软件是开源、非商业项目；下列数据都在构建期抓取并内置，运行时完全离线，不会联网。' +
    '游戏内的名称、图标、头像等素材版权归 <b>Battlestate Games</b> 所有，本站仅作非商业的离线查询用途。</div>';
  html += '<table class="mini-table" style="margin-top:10px"><thead><tr><th>数据文件</th><th>抓取时间</th><th>上游来源</th><th>说明</th></tr></thead><tbody>';
  for (const key of ['economy', 'market', 'bosses', 'taskGuides']) {
    const d = state.data[key];
    const meta = DUMPS[key];
    html += '<tr><td><code>data/' + escapeHtml(meta.file) + '</code></td>' +
      '<td>' + escapeHtml(d ? fmtTime(d.fetchedAt) : '缺失') + '</td>' +
      '<td>' + escapeHtml(d && d.source ? d.source : '—') + '</td>' +
      '<td>' + escapeHtml(d && d.attribution ? d.attribution : '（文件缺失，请运行 ' + meta.script + '）') + '</td></tr>';
  }
  html += '</tbody></table>';
  html += '<h4 style="color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:4px;margin:14px 0 8px">相关链接</h4>';
  html += '<div class="detail-actions" style="margin-top:0">';
  for (const l of SOURCE_LINKS) {
    html += '<button type="button" class="link-btn" data-act="open-url" data-url="' + escapeHtml(l.url) + '">' + escapeHtml(l.label) + '</button>';
  }
  html += '</div>';
  html += '<h4 style="color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:4px;margin:14px 0 8px">重新生成数据</h4>';
  html += '<div class="detail-note">物品与价格/弹药/防具/钥匙：<code>npm run fetch:upstream</code> 后 <code>npm run fetch:economy</code>（图标 <code>npm run fetch:item-icons</code>）；'
    + '交换/制作/藏身处：<code>npm run fetch:market</code>；BOSS：<code>npm run fetch:bosses</code>；'
    + '任务攻略与截图：<code>npm run fetch:guides</code> + <code>npm run fetch:shots</code>。</div>';
  html += '</div>';
  host.innerHTML = html;
  hideDetail();
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
    }
  });
  document.addEventListener('change', function (e) {
    const el = e.target.closest('[data-act="check-item"]');
    if (!el) return;
    checkHideoutItem(el.getAttribute('data-module'), Number(el.getAttribute('data-level')), el.getAttribute('data-item'), el.checked);
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hideDetail();
  });

  api.onLibraryGoto(onGoto);
}

function showMissing(key, tab) {
  const meta = DUMPS[key];
  $('#list-host').innerHTML = '<div class="placeholder">数据缺失，请运行 <code>' + escapeHtml(meta.script) +
    '</code> 重新生成 <code>data/' + escapeHtml(meta.file) + '</code>。<br>' +
    '「' + escapeHtml(tab.label) + '」页签暂时不可用，其它页签不受影响。</div>';
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
  if (loading) host.innerHTML = '<div class="placeholder">正在加载数据…（首次打开较大的 JSON 需要一两秒）</div>';

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
    host.innerHTML = '<div class="placeholder">这个页签渲染出错了：' + escapeHtml(e && e.message ? e.message : String(e)) +
      '<br>其它页签仍然可用。</div>';
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
  wireChrome();
  render();
}

init();
