#!/usr/bin/env node
/**
 * 任务数据快照脚本（构建期跑一次，之后应用完全离线）
 *
 * 数据源: json.tarkov.dev 的 /regular/{tasks,tasks_zh,traders,traders_zh}
 *   - tasks      任务结构（目标、区域坐标 zones、任务物品刷新点 possibleLocations）
 *   - tasks_zh   i18n 键 -> 中文（任务名 / 目标描述）
 *   - traders(_zh) 商人昵称
 * 地图 id 直接用我们自己的 data/maps-dump.json 校验（两边同源，实测 608/608 区域全部命中）
 *
 * 输出: data/quests-dump.json
 *
 * 用法:
 *   node tools/fetch-quests.js
 *   需要代理时: HTTPS_PROXY=http://127.0.0.1:7892 node tools/fetch-quests.js
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BASE = 'https://json.tarkov.dev/regular';
const OUT = path.join(REPO, 'data', 'quests-dump.json');

/**
 * tarkov.dev 上没翻译的商人昵称，用官方简中常用译名补齐。
 * 展示时一律"中文 · English"，所以即使译名有出入也不会认错人。
 */
const TRADER_ZH = {
  prapor: '普拉波',
  therapist: '医生',
  fence: '商人',
  skier: '滑雪者',
  peacekeeper: '维和者',
  mechanic: '机械师',
  ragman: '拉格曼',
  jaeger: '猎人',
  lightkeeper: '灯塔守望者',
  taran: '塔兰',
  'radio-station': '无线电台',
  'btr-driver': 'BTR 司机',
  ref: '竞技场裁判',
  'mr-kerman': '克尔曼',
  voevoda: '沃耶沃达',
  survivor: '幸存者',
};

/** 展示用的英文名（tarkov.dev 的 normalizedName 是 slug，直接显示不好看） */
const TRADER_EN = {
  prapor: 'Prapor',
  therapist: 'Therapist',
  fence: 'Fence',
  skier: 'Skier',
  peacekeeper: 'Peacekeeper',
  mechanic: 'Mechanic',
  ragman: 'Ragman',
  jaeger: 'Jaeger',
  lightkeeper: 'Lightkeeper',
  taran: 'Taran',
  'radio-station': 'Radio Station',
  'btr-driver': 'BTR Driver',
  ref: 'Arena Referee',
  'mr-kerman': 'Mr. Kerman',
  voevoda: 'Voevoda',
  survivor: 'Survivor',
};

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  return a && a.includes('=') ? a.split('=')[1] : dflt;
};
// --from-dir=<dir>：直接用本地已有的 <dir>/<name>.json，不联网（调试 / 受限网络用）
const FROM_DIR = arg('fromDir', null);

/** node 的 fetch 不认 HTTPS_PROXY，失败时退回用 curl 走代理 */
async function get(name) {
  if (FROM_DIR) {
    const f = path.join(FROM_DIR, `${name}.json`);
    console.log(`[local] ${name} <- ${f}`);
    return JSON.parse(fs.readFileSync(f, 'utf8')).data;
  }
  const url = `${BASE}/${name}`;
  try {
    const rsp = await fetch(url);
    if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
    const json = await rsp.json();
    console.log(`[fetch] ${name} ok`);
    return json.data;
  } catch (e) {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (!proxy) throw new Error(`${name}: ${e.message}`);
    console.log(`[fetch] ${name} 直连失败(${e.message})，改用 curl 走代理 ${proxy}`);
    const { execFileSync } = require('child_process');
    const buf = execFileSync('curl', ['-sS', '--max-time', '180', '-x', proxy, url], { maxBuffer: 128 * 1024 * 1024 });
    return JSON.parse(buf.toString('utf8')).data;
  }
}

/** 把 zones.outline 压成 [[x,z],...]（去掉重复的闭合点） */
function flatOutline(outline) {
  if (!Array.isArray(outline) || outline.length < 3) return null;
  const pts = outline.map((p) => [round(p.x), round(p.z)]);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length > 3 && first[0] === last[0] && first[1] === last[1]) pts.pop();
  return pts.length >= 3 ? pts : null;
}

const round = (n) => Math.round(n * 100) / 100;

/** 单个目标最多存多少个"可交/可拾取"物品 id（详情卡只展示前几个，存全部会让 dump 变得很大） */
const ITEM_LIST_CAP = 24;
const itemName = (zh, id) => zh[`${id} Name`] || zh[`${id} ShortName`] || null;

/** 截断物品清单：有中文名的排前面（详情卡展示的就是这几个） */
function capItems(list, zh) {
  const all = list || [];
  if (all.length <= ITEM_LIST_CAP) return all.slice();
  const named = [];
  const rest = [];
  for (const id of all) (itemName(zh, id) ? named : rest).push(id);
  return [...named, ...rest].slice(0, ITEM_LIST_CAP);
}

/** 前置链深度 -> 阶段（0 = 起始，越大越靠后） */
function computeStages(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map();
  const walk = (id, seen) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0; // 防御：数据里若有环
    seen.add(id);
    const t = byId.get(id);
    let d = 0;
    for (const r of (t && t.taskRequirements) || []) {
      if (r.task && byId.has(r.task)) d = Math.max(d, walk(r.task, seen) + 1);
    }
    seen.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const t of tasks) walk(t.id, new Set());
  return depth;
}

(async () => {
  const mapsDump = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'maps-dump.json'), 'utf8'));
  const ourMaps = new Map();
  for (const m of mapsDump.maps) {
    const d = m.detail;
    if (d && d.id) ourMaps.set(d.id, { key: d.key, name: d.name, normalizedName: d.normalizedName });
  }

  const [tasksRaw, zh, tradersRaw, tradersZh, itemsZh] = await Promise.all([
    get('tasks'),
    get('tasks_zh'),
    get('traders'),
    get('traders_zh'),
    get('items_zh'),
  ]);

  const tasks = Object.values(tasksRaw.tasks || tasksRaw);
  const traders = Object.values(tradersRaw.traders || tradersRaw);
  const tx = (k) => (k && zh[k]) || null;

  const depth = computeStages(tasks);

  // 商人表
  const traderList = traders
    .map((t) => ({
      id: t.id,
      slug: t.normalizedName,
      nickname: TRADER_EN[t.normalizedName] || String(t.normalizedName || t.id),
      name: TRADER_ZH[t.normalizedName] || tradersZh[`${t.id} Nickname`] || String(t.normalizedName || t.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const traderById = new Map(traderList.map((t) => [t.id, t]));

  let zoneCount = 0;
  let spotCount = 0;
  const usedMaps = new Set();
  const usedItems = new Set(); // 任务引用到的物品/钥匙 id（详情卡要显示中文名）

  const out = [];
  for (const t of tasks) {
    const maps = new Set();
    if (t.map) maps.add(t.map);
    const objectives = [];
    for (const o of t.objectives || []) {
      if (o.questItem) usedItems.add(o.questItem);
      for (const i of o.items || []) usedItems.add(i);
      for (const grp of o.requiredKeys || []) for (const k of grp || []) usedItems.add(k);
      const zones = [];
      for (const z of o.zones || []) {
        const mid = typeof z.map === 'string' ? z.map : z.map && z.map.id;
        if (!mid || !ourMaps.has(mid)) continue; // 没有底图的图直接丢掉，免得点了没反应
        maps.add(mid);
        const outline = flatOutline(z.outline);
        if (!z.position) continue;
        zones.push({
          map: mid,
          x: round(z.position.x),
          y: round(z.position.y),
          z: round(z.position.z),
          top: z.top == null ? null : round(z.top),
          bottom: z.bottom == null ? null : round(z.bottom),
          outline,
        });
        zoneCount++;
        usedMaps.add(mid);
      }
      const spots = [];
      for (const pl of o.possibleLocations || []) {
        if (!pl.map || !ourMaps.has(pl.map)) continue;
        maps.add(pl.map);
        for (const p of pl.positions || []) {
          spots.push({ map: pl.map, x: round(p.x), y: round(p.y), z: round(p.z) });
          spotCount++;
          usedMaps.add(pl.map);
        }
      }
      for (const m of o.maps || []) maps.add(m);

      objectives.push({
        id: o.id,
        type: o.type,
        text: tx(o.description) || tx(o.id) || tx(`${o.id} description`) || '',
        count: o.count || 1,
        optional: Boolean(o.optional),
        maps: o.maps || [],
        item: o.questItem || null,
        // 需要钥匙 / 可交·可拾取的物品清单（详情卡要显示中文名）
        // 清单截断前"有中文名的优先"——否则前几个可能全是没名字的任务专用占位物品
        requiredKeys: (o.requiredKeys || []).map((g) => g || []).filter((g) => g.length),
        itemIds: capItems(o.items, itemsZh),
        itemTotal: (o.items || []).length,
        zones,
        spots,
      });
    }

    out.push({
      id: t.id,
      name: tx(t.name) || tx(`${t.id} name`) || t.id,
      nameEn: t.normalizedName ? null : null, // 预留
      trader: t.trader || null,
      level: t.minPlayerLevel || 0,
      stage: depth.get(t.id) || 0,
      kappa: Boolean(t.kappaRequired),
      lightkeeper: Boolean(t.lightkeeperRequired),
      wiki: t.wikiLink || null,
      requires: (t.taskRequirements || []).map((r) => r.task).filter(Boolean),
      maps: [...maps].filter((m) => ourMaps.has(m)),
      objectives,
    });
  }

  // 只保留我们认得的图（不认得的图说明本地没有这张地图的底图）
  const mapIndex = {};
  for (const mid of usedMaps) {
    const m = ourMaps.get(mid);
    if (m) mapIndex[mid] = m;
    else console.warn('[warn] 本地 maps-dump 里没有这张图:', mid);
  }

  // 物品/钥匙中文名（只保留任务真正引用到的 id，控制在几百 KB 内）
  const items = {};
  let named = 0;
  for (const id of usedItems) {
    const name = itemsZh[`${id} Name`] || itemsZh[`${id} ShortName`];
    if (name) {
      items[id] = name;
      named++;
    }
  }

  const dump = {
    fetchedAt: new Date().toISOString(),
    source: BASE,
    attribution: '任务/坐标数据来自 tarkov.dev（社区数据），仅供离线查询',
    traders: traderList,
    maps: mapIndex,
    items,
    tasks: out,
  };
  fs.writeFileSync(OUT, JSON.stringify(dump));
  const size = fs.statSync(OUT).size;
  const withZones = out.filter((t) => t.objectives.some((o) => o.zones.length)).length;
  const withSpots = out.filter((t) => t.objectives.some((o) => o.spots.length)).length;
  console.log(
    `[done] tasks=${out.length} traders=${traderList.length} 带区域任务=${withZones} 带刷新点任务=${withSpots} ` +
      `zones=${zoneCount} spots=${spotCount} 地图=${Object.keys(mapIndex).length} ` +
      `物品名=${named}/${usedItems.size} -> ${path.relative(REPO, OUT)} (${(size / 1024).toFixed(0)} KB)`,
  );
})().catch((e) => {
  console.error('[fatal]', e && e.message ? e.message : e);
  process.exit(1);
});
