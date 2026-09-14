#!/usr/bin/env node
/**
 * 抓取"赛季文件刷点"数据（版本活动：在地图上找赛季文件）
 *
 * 数据来源（均为公开只读接口）：
 *   GET /api/tarkov/season-document/location/list?mapId=<id>   -> 各图已审核通过的刷点 {position,item,image}
 *   GET /api/tarkov/item/detail?id=<id>&lang=zh&gameMode=pve  -> 文件中文名/说明/图标
 * 输出：
 *   data/season-documents.json      （点位 + 类型元数据）
 *   data/icons/season_<type>.webp   （类型图标，离线使用）
 *
 * 用法: node tools/fetch-season.js [--lang=zh] [--images]
 *   --images  额外下载参考位置截图到 data/season-images/（体积大，默认不下载）
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BASE = 'https://member.kaedeori.com';

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  if (!a) return dflt;
  return a.includes('=') ? a.split('=')[1] : true;
};
const LANG = arg('lang', 'zh');
const WANT_IMAGES = process.argv.includes('--images');

// 赛季文件类型（原站 main.js 内 YW 常量：itemId -> 类型 key）
const TYPES = [
  { itemId: '6a317b9692cfdcddcb02a58e', type: 'pmc', name: 'PMC人员档案', short: 'PMC' },
  { itemId: '6a3182dc6cd8de21cf0a3a7d', type: 'medical', name: '医疗文件', short: '医疗' },
  { itemId: '6a31807f17005505b70d5827', type: 'finances', name: '财务文件', short: '财务' },
  { itemId: '6a3182b72fd891345e047eef', type: 'employee', name: '员工文件', short: '员工' },
  { itemId: '6a31830dde69ceafd805afa0', type: 'technical', name: '技术文件', short: '技术' },
  { itemId: '6a31824878450ec91c0ea1ae', type: 'blueprints', name: '蓝图与技术文件', short: '蓝图' },
  { itemId: '6a31828557705071410ca00e', type: 'test', name: '测试文件', short: '测试' },
  { itemId: '6a3181f178450ec91c0ea1aa', type: 'project', name: '项目文件', short: '项目' },
];
const COLOR = {
  pmc: '#f97316', medical: '#22c55e', finances: '#eab308', employee: '#38bdf8',
  technical: '#a78bfa', blueprints: '#06b6d4', test: '#f472b6', project: '#fb7185',
};

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

(async () => {
  const dump = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'maps-dump.json'), 'utf8'));

  // 1) 类型元数据（中文名 / 说明 / 图标）
  const meta = {};
  for (const t of TYPES) {
    let detail = null;
    try {
      const j = await getJson(`${BASE}/api/tarkov/item/detail?id=${t.itemId}&lang=${LANG}&gameMode=pve`);
      detail = j?.data?.data || null;
    } catch (e) {
      console.warn('[item] 失败', t.type, e.message);
    }
    meta[t.itemId] = {
      itemId: t.itemId,
      type: t.type,
      name: detail?.name || t.name,          // 中文全名（接口优先）
      shortName: t.short,                     // 图例短名（原站 i18n 中文）
      shortNameApi: detail?.shortName || null,
      description: detail?.description || null,
      color: COLOR[t.type] || '#94a3b8',
      icon: `season_${t.type}.webp`,
    };
    // 2) 下载图标（webp，Chromium 可直接渲染）
    const iconUrl = detail?.iconLink || `https://cdn.kaedeori.com/uploads/tarkov/icons/${t.itemId}-icon.webp`;
    try {
      const r = await fetch(iconUrl);
      if (r.ok) {
        fs.writeFileSync(path.join(REPO, 'data', 'icons', `season_${t.type}.webp`), Buffer.from(await r.arrayBuffer()));
        console.log('[icon]', t.type, 'ok', iconUrl);
      } else console.warn('[icon]', t.type, r.status);
    } catch (e) { console.warn('[icon]', t.type, e.message); }
    console.log('[type]', t.type, meta[t.itemId].name, '/', meta[t.itemId].shortName);
  }

  // 3) 各图刷点
  const maps = {};
  const byMapId = new Map(dump.maps.map((m) => [m.detail.id, m.detail]));
  let total = 0;
  let seasonSeen = 0;
  const imageDir = path.join(REPO, 'data', 'season-images');
  if (WANT_IMAGES) fs.mkdirSync(imageDir, { recursive: true });

  for (const m of dump.maps) {
    const id = m.detail.id;
    let list = [];
    try {
      const j = await getJson(`${BASE}/api/tarkov/season-document/location/list?mapId=${id}`);
      list = j?.data?.list || [];
    } catch (e) {
      console.warn('[list] 失败', m.name, e.message);
      continue;
    }
    const out = [];
    for (const e of list) {
      const t = meta[e.item?.id];
      seasonSeen = e.season || seasonSeen;
      out.push({
        uuid: e.uuid,
        itemId: e.item?.id,
        type: t?.type || null,
        x: e.position?.x, y: e.position?.y, z: e.position?.z,
        image: e.image?.url || null,
      });
      if (WANT_IMAGES && e.image?.url) {
        const file = `${e.uuid}.webp`;
        const dst = path.join(imageDir, file);
        if (!fs.existsSync(dst)) {
          try {
            const r = await fetch(e.image.url);
            if (r.ok) fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
          } catch {}
        }
        out[out.length - 1].imageLocal = `season-images/${file}`;
      }
    }
    if (out.length) {
      maps[id] = { key: m.detail.key, name: m.detail.name, points: out };
      total += out.length;
    }
    console.log('[map]', String(m.name).padEnd(12), out.length, '个刷点');
  }

  const result = {
    fetchedAt: new Date().toISOString(),
    season: seasonSeen || 1,
    source: `${BASE}/api/tarkov/season-document/location/list`,
    note: '赛季文件刷点 = 版本活动在各地图刷新的"赛季文件"位置（社区提交 + 官方审核通过）。',
    types: meta,
    typeOrder: TYPES.map((t) => t.itemId),
    total,
    maps,
  };
  fs.writeFileSync(path.join(REPO, 'data', 'season-documents.json'), JSON.stringify(result, null, 2));
  console.log(`\n[done] 赛季 ${result.season}，共 ${total} 个刷点，覆盖 ${Object.keys(maps).length} 张地图 -> data/season-documents.json`);
  console.log('       mapId->key 对照:', [...byMapId.entries()].slice(0, 3).map(([i, d]) => `${i}=${d.key}`).join(' '), '...');
})().catch((e) => { console.error('[fatal]', e); process.exit(1); });
