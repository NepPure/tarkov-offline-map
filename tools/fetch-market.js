#!/usr/bin/env node
/**
 * 市场经济数据汇总（构建期跑一次，应用里完全离线）
 *
 * 数据源: json.tarkov.dev 的 {regular,pve}/{barters,crafts,hideout,traders}
 *   - barters  商人以物易物：requiredItems -> require，offeredItem -> reward
 *   - crafts   工作台配方：requiredItems -> require（带 tool 标记），productItem -> reward
 *   - hideout  藏身处模块与升级材料（两模式结构相同，有 pve 就优先用 pve）
 *   - traders  barter 里只有商人 id，这里换成 normalizedName
 * 默认读 build/upstream/<mode>-<name>.json 缓存（tools/fetch-upstream 下载），
 * 缓存没有再联网；--refresh 强制联网刷新缓存。
 *
 * 价格字段（做这一单划不划算）优先用 data/economy-dump.json 的现价折算；
 * 该文件不存在时（fetch-economy.js 跑挂过）退回 build/upstream/<mode>-items.json 现算：
 *   sourcePrice       = require 物品跳蚤价合计
 *   targetPrice       = reward 物品跳蚤价合计
 *   targetSellerPrice = reward 卖给商人的最高价合计
 * 实在没有价格数据时为 null。字段名保持英文、值只保留原始 id
 * （中文名由应用层查 economy-dump.json 的 items[]）。
 *
 * 输出: data/market-dump.json
 *   { fetchedAt, source, attribution, barters[], crafts[], hideout: { mode, modules[] } }
 *   每条 barter/craft 都带 mode: "regular"(=PVP) | "pve"
 *
 * 用法:
 *   node tools/fetch-market.js [--refresh] [--cache=build/upstream] [--mode=regular,pve]
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BASE = 'https://json.tarkov.dev';
const OUT = path.join(REPO, 'data', 'market-dump.json');
const ECON = path.join(REPO, 'data', 'economy-dump.json');
const UA = 'tarkov-offline-map/2.5 (+https://github.com/neppure/tarkov-offline-map)';

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  return a && a.includes('=') ? a.split('=')[1] : dflt;
};
const CACHE = path.resolve(REPO, arg('cache', path.join('build', 'upstream')));
const MODES = arg('mode', 'regular,pve').split(',').filter(Boolean);
const REFRESH = process.argv.includes('--refresh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(mode, name) {
  const file = path.join(CACHE, `${mode}-${name}.json`);
  if (!REFRESH && fs.existsSync(file) && fs.statSync(file).size > 1024) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.data != null) return j.data;
      console.warn(`[warn] ${mode}/${name} 缓存缺 data，改用联网`);
    } catch (e) {
      console.warn(`[warn] ${mode}/${name} 缓存解析失败，改用联网：${e.message}`);
    }
  }
  const url = `${BASE}/${mode}/${name}`;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file, text);
      console.log(`[fetch] ${mode}/${name} ${(text.length / 1048576).toFixed(1)} MB`);
      return JSON.parse(text).data;
    } catch (e) {
      lastErr = e;
      await sleep(800 * (i + 1));
    }
  }
  throw new Error(`${url} 读取失败：${lastErr && lastErr.message}`);
}

const maxOf = (list) => (list.length ? Math.max(...list) : null);

// id -> { regular: { flea, sell }, pve: { flea, sell } }
function loadPrices() {
  const map = new Map();
  const put = (id, mode, rec) => { const e = map.get(id) || {}; e[mode] = rec; map.set(id, e); };

  if (fs.existsSync(ECON)) {
    const j = JSON.parse(fs.readFileSync(ECON, 'utf8'));
    for (const it of j.items || []) {
      const per = (k) => {
        const p = (it.p && it.p[k]) || {};
        const sell = (p.sell || []).map((s) => s.p).filter((n) => typeof n === 'number' && n > 0);
        return { flea: p.avg ?? p.last ?? p.base ?? null, sell: maxOf(sell) };
      };
      put(it.id, 'regular', per('regular'));
      put(it.id, 'pve', per('pve'));
    }
    return { map, from: 'data/economy-dump.json' };
  }

  // 退路：直接读上游 items 快照
  for (const mode of MODES) {
    const file = path.join(CACHE, `${mode}-items.json`);
    if (!fs.existsSync(file)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')).data; } catch { continue; }
    const items = Array.isArray(data && data.items) ? data.items : Object.values((data && data.items) || {});
    for (const it of items) {
      if (!it || !it.id) continue;
      const sell = (it.sellToTrader || []).map((s) => s.priceRUB ?? s.price).filter((n) => typeof n === 'number' && n > 0);
      put(it.id, mode, { flea: it.avg24hPrice ?? it.lastLowPrice ?? it.basePrice ?? null, sell: maxOf(sell) });
    }
  }
  return { map, from: map.size ? 'build/upstream/<mode>-items.json' : null };
}

function sumPrice(prices, mode, items, field) {
  if (!prices) return null;
  let sum = 0, hit = 0;
  for (const x of items) {
    const rec = prices.get(x.item);
    const v = rec && rec[mode] ? rec[mode][field] : null;
    if (typeof v === 'number' && v > 0) { sum += v * (x.count || 1); hit++; }
  }
  return hit ? Math.round(sum) : null;
}

(async () => {
  const { map: prices, from: priceFrom } = loadPrices();
  if (!prices.size) console.warn('[warn] 没有任何价格源，sourcePrice/targetPrice/targetSellerPrice 为 null');

  // 商人 id -> normalizedName
  const traders = {};
  for (const mode of MODES) {
    let t;
    try { t = await get(mode, 'traders'); } catch (e) { console.warn('[warn] ' + e.message); continue; }
    for (const x of Object.values((t && t.traders) || t || {})) {
      if (x && x.id) traders[x.id] = x.normalizedName || x.name || x.id;
    }
  }

  const barters = [];
  const crafts = [];
  const per = {};

  for (const mode of MODES) {
    let raw = [];
    try { raw = (await get(mode, 'barters')) || []; } catch (e) { console.warn('[warn] ' + e.message); }
    for (const b of raw) {
      const require = (b.requiredItems || []).map((r) => ({ item: r.item, count: r.count }));
      const reward = b.offeredItem ? [{ item: b.offeredItem.item, count: b.offeredItem.count }] : [];
      barters.push({
        id: b.id,
        mode,
        traderId: b.trader || null,
        trader: traders[b.trader] || b.trader || null,
        level: b.minTraderLevel ?? null,
        taskUnlock: b.taskUnlock || null,
        require,
        reward,
        sourcePrice: sumPrice(prices, mode, require, 'flea'),
        targetPrice: sumPrice(prices, mode, reward, 'flea'),
        targetSellerPrice: sumPrice(prices, mode, reward, 'sell'),
      });
    }

    let cr = [];
    try { cr = (await get(mode, 'crafts')) || []; } catch (e) { console.warn('[warn] ' + e.message); }
    for (const c of cr) {
      crafts.push({
        id: c.id,
        mode,
        stationId: c.station || null,
        level: c.level ?? null,
        taskUnlock: c.taskUnlock || null,
        duration: c.duration ?? null,
        require: (c.requiredItems || []).map((r) => ({
          item: r.item,
          count: r.count,
          tool: !!(r.attributes && r.attributes.tool),
        })),
        reward: c.productItem ? [{ item: c.productItem.item, count: c.productItem.count }] : [],
      });
    }
    per[mode] = { barters: raw.length, crafts: cr.length };
  }

  // 藏身处：两模式结构相同，有 pve 就用 pve
  let hoMode = MODES.includes('pve') ? 'pve' : MODES[0];
  let ho = null;
  try { ho = await get(hoMode, 'hideout'); } catch (e) {
    console.warn('[warn] ' + e.message);
    hoMode = MODES.includes('regular') ? 'regular' : MODES[0];
    try { ho = await get(hoMode, 'hideout'); } catch (e2) { console.warn('[warn] ' + e2.message); ho = {}; }
  }
  const modules = Object.values(ho || {}).map((m) => ({
    id: m.id,
    name: m.name || null,
    normalizedName: m.normalizedName || null,
    levels: (m.levels || []).map((l) => {
      const rec = {
        level: l.level ?? null,
        constructionTime: l.constructionTime ?? null,
        requirements: (l.itemRequirements || []).map((r) =>
          r.attributes && r.attributes.foundInRaid ? { item: r.item, count: r.count, fir: true } : { item: r.item, count: r.count }),
      };
      const sl = (l.stationLevelRequirements || []).map((s) => ({ station: s.station, level: s.level }));
      if (sl.length) rec.stationLevels = sl;
      return rec;
    }),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: 'json.tarkov.dev (tarkov.dev)',
    attribution: '数据来自 tarkov.dev（https://tarkov.dev），游戏素材版权归 Battlestate Games 所有。',
    barters,
    crafts,
    hideout: { mode: hoMode, modules },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  const size = fs.statSync(OUT).size;

  // 数量级自检
  for (const mode of Object.keys(per)) {
    if (per[mode].barters < 800) console.warn(`[warn] ${mode} barters 只有 ${per[mode].barters} 条（预期 ~855）`);
    if (per[mode].crafts < 150 || per[mode].crafts > 300) console.warn(`[warn] ${mode} crafts ${per[mode].crafts} 条（预期 ~210）`);
  }
  if (barters.length < 800) console.warn(`[warn] barters 合计只有 ${barters.length} 条（预期两模式合计 >=800）`);
  if (modules.length < 20) console.warn(`[warn] hideout 模块只有 ${modules.length} 个（预期 ~26）`);

  console.log(`[out] ${OUT} ${(size / 1048576).toFixed(2)} MB`);
  console.log(`[out] barters ${barters.length}（${Object.entries(per).map(([m, v]) => m + ' ' + v.barters).join(' / ')}）`);
  console.log(`[out] crafts ${crafts.length}（${Object.entries(per).map(([m, v]) => m + ' ' + v.crafts).join(' / ')}）`);
  console.log(`[out] hideout(${hoMode}) 模块 ${modules.length} 层 ${modules.reduce((n, m) => n + m.levels.length, 0)}`);
  console.log(`[out] 价格折算源: ${priceFrom || '无（字段为 null）'}`);
})();
