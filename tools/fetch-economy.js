#!/usr/bin/env node
/**
 * 经济数据快照（构建期跑一次，应用里完全离线）
 *
 * 数据源: json.tarkov.dev 的 {regular,pve}/{items,items_zh,traders,traders_zh}
 *   - items      物品 + 跳蚤/商人价格（两套模式各一份）
 *   - items_zh   中文名/短名/说明
 *   - traders(_zh) 商人昵称（sellFor 里只有商人 id）
 * 默认先读 build/upstream/<mode>-<name>.json 缓存（tools/fetch-upstream 下载），
 * 缓存没有再联网；--refresh 强制联网刷新缓存。
 *
 * 输出: data/economy-dump.json
 *   { fetchedAt, source, attribution, modes, categories[], items[], ammo[], gear[], traders{} }
 *   items[].p = { regular: <price>, pve: <price> }（PVP = regular）
 *
 * 用法:
 *   node tools/fetch-economy.js [--refresh] [--cache=build/upstream]
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BASE = 'https://json.tarkov.dev';
const CACHE = path.join(REPO, 'build', 'upstream');
const OUT = path.join(REPO, 'data', 'economy-dump.json');
const MODES = ['regular', 'pve'];

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  return a && a.includes('=') ? a.split('=')[1] : dflt;
};
const REFRESH = process.argv.includes('--refresh');

const TRADER_ZH = {
  prapor: '普拉波', therapist: '医生', fence: '商人', skier: '滑雪者', peacekeeper: '维和者',
  mechanic: '机械师', ragman: '拉格曼', jaeger: '猎人', lightkeeper: '灯塔守望者',
  taran: '塔兰', 'radio-station': '无线电台', 'btr-driver': 'BTR 司机', ref: '竞技场裁判',
  'mr-kerman': '克尔曼', voevoda: '沃耶沃达', survivor: '幸存者',
};

async function get(mode, name) {
  const file = path.join(CACHE, `${mode}-${name}.json`);
  if (!REFRESH && fs.existsSync(file) && fs.statSync(file).size > 1024) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).data;
  }
  const url = `${BASE}/${mode}/${name}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const text = await r.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`[fetch] ${mode}/${name} ${(text.length / 1048576).toFixed(1)} MB`);
  return JSON.parse(text).data;
}

const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (o && o[k] != null) out[k] = o[k];
  return out;
};

const AMMO_KEYS = ['caliber', 'damage', 'armorDamage', 'fragmentationChance', 'ricochetChance',
  'penetrationPower', 'penetrationPowerDeviation', 'accuracyModifier', 'recoilModifier',
  'initialSpeed', 'lightBleedModifier', 'heavyBleedModifier', 'stackMaxSize', 'tracer', 'tracerColor',
  'projectileCount', 'ammoType'];

const GEAR_KEYS = ['class', 'durability', 'material', 'zones', 'armorType', 'speedPenalty',
  'turnPenalty', 'ergoPenalty', 'blindnessProtection', 'blocksEarpiece', 'blocksEyewear',
  'blocksFaceCover', 'blocksHeadwear', 'defaultPreset', 'weight'];

/**
 * 跳蚤价格。changeLast48hPercent 在 tarkov.dev 里**已经是百分数**（-0.96 = -0.96%，
 * 与 changeLast48h/价格 对得上），原样透传即可 —— 早期版本在这里多乘了一次 100，导致涨跌幅放大 100 倍。
 */
function priceOf(it) {
  if (!it) return null;
  const vendorOf = (s) => (s.vendor && (s.vendor.name || s.vendor.id)) || s.trader || null;
  return {
    base: it.basePrice ?? null,
    last: it.lastLowPrice ?? null,
    avg: it.avg24hPrice ?? null,
    low24: it.low24hPrice ?? null,
    high24: it.high24hPrice ?? null,
    ch48: it.changeLast48h ?? null,
    ch48p: it.changeLast48hPercent == null ? null : Math.round(it.changeLast48hPercent * 100) / 100, // tarkov.dev 这里**已经是百分数**（-0.96 = -0.96%），别再多乘 100
    offers: it.lastOfferCount ?? null,
    updated: it.updated ?? null,
    scan: it.lastScan ?? null,
    sell: (it.sellFor || it.sellToTrader || []).map((s) => ({ t: vendorOf(s), p: s.priceRUB ?? s.price ?? null })).filter((s) => s.t && s.p),
    buy: (it.buyFor || it.buyFromTrader || []).map((s) => ({ t: vendorOf(s), p: s.priceRUB ?? s.price ?? null })).filter((s) => s.t && s.p),
  };
}

(async () => {
  const [itemsR, itemsP, zhR, enR, tradersR, tradersZh] = await Promise.all([
    get('regular', 'items'),
    get('pve', 'items'),
    get('regular', 'items_zh'),
    get('regular', 'items_en').catch(() => ({})),
    get('regular', 'traders'),
    get('regular', 'traders_zh'),
  ]);

  const listR = Object.values(itemsR.items || itemsR);
  const listP = Object.values(itemsP.items || itemsP);
  const byP = new Map(listP.map((x) => [x.id, x]));
  const zh = zhR || {};
  const en = enR || {};
  // tarkov.dev 的 items 里 name/shortName 是 **i18n 键**（"<id> Name"），不是人名；
  // 没翻译到的物品会原样漏到界面上（"69bb3f… Name" 这种），所以两边都做一次兜底。
  const isKey = (s) => !s || /^[0-9a-f]{24} /.test(String(s));
  const zhName = (id) => zh[`${id} Name`] || null;
  const zhShort = (id) => zh[`${id} ShortName`] || null;
  const enName = (id) => en[`${id} Name`] || null;
  const enShort = (id) => en[`${id} ShortName`] || null;

  // 商人昵称
  const traders = {};
  for (const t of Object.values(tradersR.traders || tradersR)) {
    traders[t.id] = {
      slug: t.normalizedName || null,
      name: TRADER_ZH[t.normalizedName] || tradersZh[`${t.id} Nickname`] || t.normalizedName || t.id,
    };
  }

  // 分类（itemCategories 是"槽位/类型"树，handbookCategories 是图鉴分类）
  // itemCategories / handbookCategories 都是 { id: {...} } 对象
  const cats = new Map();
  const addCats = (obj, kind) => {
    for (const c of Object.values(obj || {})) {
      if (!c || !c.id) continue;
      const name = zh[`${c.id} Name`] || zh[c.name] || c.name || c.id;
      if (cats.has(c.id)) { if (kind === 'handbook') cats.get(c.id).handbook = true; continue; }
      cats.set(c.id, { id: c.id, name, parent: (c.parent && c.parent.id) || c.parent || null, kind, handbook: kind === 'handbook' });
    }
  };
  addCats(itemsR.itemCategories, 'item');
  addCats(itemsR.handbookCategories, 'handbook');

  const items = [];
  const ammo = [];
  const gear = [];
  const keys = [];
  for (const it of listR) {
    const other = byP.get(it.id) || {};
    const types = it.types || [];
    const props = it.properties || {};
    const propsType = props.propertiesType || null;
    const name = zhName(it.id) || (isKey(it.name) ? (enName(it.id) || it.id) : it.name);
    const short = zhShort(it.id) || (isKey(it.shortName) ? enShort(it.id) : it.shortName) || null;
    const rec = {
      id: it.id,
      name,
      short,
      nameEn: isKey(it.name) ? enName(it.id) : it.name,
      shortEn: isKey(it.shortName) ? enShort(it.id) : it.shortName,
      w: it.width || 1,
      h: it.height || 1,
      weight: it.weight ?? null,
      bg: it.backgroundColor || null,
      types,
      cat: (it.categories && it.categories[0]) || null,
      cats: it.handbookCategories || [],
      propsType,
      wiki: it.wikiLink || null,
      minFlea: it.minLevelForFlea ?? null,
      icon: `${it.id}-icon.webp`,
      grid: `${it.id}-grid.webp`,
      p: { regular: priceOf(it), pve: priceOf(other) },
    };
    items.push(rec);

    if (propsType === 'ItemPropertiesAmmo') {
      ammo.push({ id: it.id, name, short, weight: it.weight ?? null, ...pick(props, AMMO_KEYS), p: rec.p });
    }
    if (propsType === 'ItemPropertiesKey') {
      keys.push({ id: it.id, name, short, uses: props.uses ?? null, weight: it.weight ?? null, p: rec.p });
    }
    if (['ItemPropertiesArmor', 'ItemPropertiesHelmet', 'ItemPropertiesChestRig', 'ItemPropertiesArmorAttachment'].includes(propsType)) {
      gear.push({ id: it.id, name, short, propsType, types, ...pick(props, GEAR_KEYS), p: rec.p });
    }
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: 'json.tarkov.dev (tarkov.dev)',
    attribution: '物品与价格数据来自 tarkov.dev（https://tarkov.dev），游戏素材版权归 Battlestate Games 所有。',
    modes: MODES,
    traders,
    categories: [...cats.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')),
    items,
    keys: keys.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')),
    ammo: ammo.sort((a, b) => (b.penetrationPower || 0) - (a.penetrationPower || 0) || String(a.name).localeCompare(String(b.name), 'zh')),
    gear,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));

  // 轻量价格索引：主地图窗口只为了"任务要交的东西值多少钱"就要解析 8MB 太浪费，
  // 这里出一份只含价格的小文件（~0.3MB），渲染层按需加载。
  const idx = {};
  for (const it of items) {
    const trip = (q) => {
      if (!q) return [null, null, null];
      let trader = null;
      for (const s of q.sell || []) if (s.p != null && (trader == null || s.p > trader)) trader = s.p;
      return [q.last ?? null, q.avg ?? null, trader];
    };
    idx[it.id] = [...trip(it.p.regular), ...trip(it.p.pve)];
  }
  const IDX = path.join(REPO, 'data', 'price-index.json');
  fs.writeFileSync(IDX, JSON.stringify({
    fetchedAt: payload.fetchedAt,
    note: '物品 -> [pvp当前价, pvp24h均价, pvp最高商人收购, pve当前价, pve24h均价, pve最高商人收购]',
    attribution: payload.attribution,
    data: idx,
  }));
  console.log(`[out] ${IDX} ${(fs.statSync(IDX).size / 1024).toFixed(0)} KB（${Object.keys(idx).length} 件）`);
  const withPrice = items.filter((i) => i.p.regular.last || i.p.regular.avg).length;
  console.log(`[out] ${OUT} ${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB`);
  console.log(`[out] 物品 ${items.length}（有价 ${withPrice}）分类 ${payload.categories.length} 弹药 ${ammo.length} 防具 ${gear.length} 钥匙 ${keys.length}`);
  console.log(`[out] 上游 updated 示例: ${items[0] && items[0].p.regular.updated}`);
})();
