#!/usr/bin/env node
/**
 * 下载"没有 SVG 的地图"的瓦片底图 —— 实验室 (the-lab)、迷宫 (the-labyrinth)、破冰船 (icebreaker)。
 *
 * 原站对这些图走"卫星图"渲染（renderer/common/map-view.js 的 satelliteLayout 复刻了它的几何）：
 * 瓦片金字塔的层级是**固定 zoom=3** 的，也就是每层 8×8 = 64 块。z=4/5/6 在 CDN 上并不存在
 * （本工具早期版本照着 minZoom..maxZoom 去扫，白跑了两万多次 404），所以这里只下这一层。
 *
 * 落盘布局跟 CDN 保持一致，只把主机名换成 data/tiles：
 *   https://…/assets/maps/labs_v4/1st/{z}/{x}/{y}.png -> data/tiles/labs_v4/1st/3/0/1.png
 * 目录名由 src/tiles.js 的 tileBaseOf() 统一算 —— 渲染层用的是同一份（主进程扫盘后下发），
 * 两边不会各写一套规则。
 *
 * 用法:
 *   node tools/fetch-tiles.js                      # 下全部无 SVG 的图
 *   node tools/fetch-tiles.js --maps=the-lab       # 只下某几张（逗号分隔，匹配 detail.key）
 *   node tools/fetch-tiles.js --force              # 重下（默认跳过已存在的文件）
 */
const fs = require('fs');
const path = require('path');
const { SATELLITE_ZOOM, tileBaseOf } = require('../src/tiles');

const REPO = path.join(__dirname, '..');
const DUMP = path.join(REPO, 'data', 'maps-dump.json');
const OUT_ROOT = path.join(REPO, 'data', 'tiles');

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}`));
  return a && a.includes('=') ? a.split('=')[1] : dflt;
};
const FORCE = process.argv.includes('--force');
const ONLY = new Set(String(arg('maps', '')).split(',').map((s) => s.trim()).filter(Boolean));

/** 礼貌的并发：CDN 上没有 CDN 加速的小站，别一次糊 64 个请求上去 */
const CONCURRENCY = Number(arg('concurrency', 6)) || 6;

async function pool(items, worker, limit = CONCURRENCY) {
  const queue = [...items];
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (i < queue.length) {
      const idx = i++;
      out[idx] = await worker(queue[idx], idx);
    }
  }));
  return out;
}

/** 下完一层瓦片，返回 {ok, miss} */
async function fetchLayer(tilePath, outDir, zoom) {
  const n = 2 ** zoom;
  const jobs = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) jobs.push({ x, y });
  const stats = await pool(jobs, async ({ x, y }) => {
    const file = path.join(outDir, String(zoom), String(x), `${y}.png`);
    if (!FORCE && fs.existsSync(file) && fs.statSync(file).size > 0) return 'skip';
    const url = tilePath.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y));
    try {
      const rsp = await fetch(url, { redirect: 'follow' });
      if (!rsp.ok) return 'miss';
      const buf = Buffer.from(await rsp.arrayBuffer());
      if (!buf.length) return 'miss';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      return 'ok';
    } catch (e) {
      return 'miss';
    }
  });
  return {
    ok: stats.filter((s) => s === 'ok').length,
    skip: stats.filter((s) => s === 'skip').length,
    miss: stats.filter((s) => s === 'miss').length,
  };
}

async function main({ maps = null } = {}) {
  let list = maps;
  if (!list) {
    if (!fs.existsSync(DUMP)) {
      console.error(`[tiles] 缺少 ${path.relative(REPO, DUMP)}，先跑 npm run fetch:data`);
      process.exit(1);
    }
    list = JSON.parse(fs.readFileSync(DUMP, 'utf-8')).maps;
  }
  const zoom = SATELLITE_ZOOM;
  const grand = { ok: 0, skip: 0, miss: 0, layers: 0, maps: 0 };
  for (const m of list) {
    const d = m.detail;
    if (!d || d.svgPath) continue;                       // 有 SVG 的图不用瓦片
    if (ONLY.size && !ONLY.has(d.key)) continue;
    const targets = [];
    if (d.tilePath) targets.push(d.tilePath);
    for (const l of d.layers || []) if (l.tilePath && !targets.includes(l.tilePath)) targets.push(l.tilePath);
    if (!targets.length) continue;
    grand.maps++;
    console.log(`[tiles] ${d.key} (${d.name}) 共 ${targets.length} 层`);
    for (const tp of targets) {
      const rel = tileBaseOf(tp);
      if (!rel) { console.warn('  [skip] 无法从路径解析出目录:', tp); continue; }
      const outDir = path.join(OUT_ROOT, ...rel.split('/'));
      const st = await fetchLayer(tp, outDir, zoom);
      grand.ok += st.ok; grand.skip += st.skip; grand.miss += st.miss; grand.layers++;
      console.log(`  ${rel.padEnd(28)} z=${zoom} 新下 ${st.ok} / 已有 ${st.skip} / 缺失 ${st.miss}`);
    }
  }
  if (!grand.layers) {
    console.warn('[tiles] 没有可下载的层（检查 --maps= 的 key 是否写对）');
    return grand;
  }
  console.log(`[tiles] 完成：${grand.maps} 张图 / ${grand.layers} 层，新下 ${grand.ok}、已有 ${grand.skip}、缺失 ${grand.miss}`);
  console.log(`[tiles] 输出目录: ${path.relative(REPO, OUT_ROOT)}`);
  return grand;
}

module.exports = { fetchTiles: main };

if (require.main === module) {
  main().catch((e) => { console.error('[tiles] 失败:', e); process.exit(1); });
}
