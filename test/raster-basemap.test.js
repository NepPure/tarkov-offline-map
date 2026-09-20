'use strict';

/**
 * 瓦片底图（实验室 / 迷宫 / 破冰船）：目录命名 + 原站卫星图几何。
 *
 * 背景：这三张图在原站没有 SVG，底图是"卫星图瓦片"。此前的实现遇到没有 svgPath 的图
 * 就直接不画底图，于是截图定位到实验室时地图上只有标记、没有地面，选图下拉里也找不到它。
 *
 * 这里盯三件事：
 *   1) 远端 tilePath -> data/tiles 目录的换算，工具与渲染层用的是同一份（src/tiles.js）
 *   2) 层级固定为 zoom=3（原站 uQe），且 8×8 的瓦片网格必须盖住整张图，不能被钳位切掉
 *   3) 瓦片落位与原站画布算法等价：地图像素空间里瓦片 (x,y) 的左上角就是 (x*tileSize/2^z, ...)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const dump = JSON.parse(fs.readFileSync(path.join(DATA, 'maps-dump.json'), 'utf8'));
const details = dump.maps.map((m) => m.detail).filter(Boolean);
/** 没有 SVG、只能靠瓦片当底图的图 */
const rasterMaps = details.filter((d) => !d.svgPath && d.tilePath);

test('tileBaseOf：远端瓦片路径 -> data/tiles 目录（保持与 CDN 同构）', () => {
  const { tileBaseOf, SATELLITE_ZOOM } = require('../src/tiles');
  assert.strictEqual(SATELLITE_ZOOM, 3, '原站卫星固定在 zoom=3（渲染层有个同名副本，必须一致）');
  const base = 'https://cdn.kaedeori.com/uploads/tarkov/interactive-map/2026-09-13.1/assets/maps';
  assert.strictEqual(tileBaseOf(`${base}/labs_v4/1st/{z}/{x}/{y}.png`), 'labs_v4/1st');
  assert.strictEqual(tileBaseOf(`${base}/labyrinth/main/{z}/{x}/{y}.png`), 'labyrinth/main');
  assert.strictEqual(tileBaseOf(`${base}/icebreaker/06_infirmary/{z}/{x}/{y}.png`), 'icebreaker/06_infirmary');
  // 带点的目录名（海关是 customs_0.16）不能被截断
  assert.strictEqual(tileBaseOf(`${base}/customs_0.16/main/{z}/{x}/{y}.png`), 'customs_0.16/main');
  assert.strictEqual(tileBaseOf(''), null);
});

test('tileBaseOf：所有瓦片层的目录唯一（否则两层会互相覆盖）', () => {
  const { tileBaseOf } = require('../src/tiles');
  const seen = new Map();
  for (const d of details) {
    const paths = [d.tilePath, ...(d.layers || []).map((l) => l.tilePath)].filter(Boolean);
    for (const tp of paths) {
      const dir = tileBaseOf(tp);
      assert.ok(dir, `${d.key} 的瓦片路径解析不出目录: ${tp}`);
      if (seen.has(dir)) assert.strictEqual(seen.get(dir), tp, `目录 ${dir} 撞车`);
      seen.set(dir, tp);
    }
  }
});

/** 标记的坐标字段有三种写法：position:{x,z}、position:[x,z]、扁平 x/z */
function markerPos(m) {
  const p = m && m.position;
  if (Array.isArray(p) && p.length >= 2) return { x: Number(p[0]), z: Number(p[1]) };
  if (p && typeof p === 'object') return { x: Number(p.x), z: Number(p.z) };
  if (m && Number.isFinite(Number(m.x)) && Number.isFinite(Number(m.z))) return { x: Number(m.x), z: Number(m.z) };
  return null;
}

/**
 * 破冰船的 bounds（285×461 地图像素）比 8×8×256 的瓦片网格还大，而 CDN 上没有 z=4 的瓦片，
 * 所以它天然只能盖住中间一块 —— 原站自己也是这么算的（索引钳在 [0, 2^z-1]）。
 * 实验室（bounds 163×119，网格 175×131）与迷宫（239×222，网格 256×256）必须完整覆盖。
 * 这里把它列成显式例外，而不是把断言放松到对所有图都没意义。
 */
const KNOWN_PARTIAL = new Set(['icebreaker']);

test('satelliteLayout：瓦片网格必须盖住整张地图（例外见 KNOWN_PARTIAL）', async () => {
  const { makeProjection, satelliteLayout, mapPixelBounds } = await import('../renderer/common/map-view.js');
  assert.ok(rasterMaps.length >= 3, '至少要能识别出实验室/迷宫/破冰船');
  for (const d of rasterMaps) {
    const proj = makeProjection(d);
    const L = satelliteLayout(d, proj);
    assert.ok(L, `${d.key} 算不出瓦片落位`);
    assert.strictEqual(L.zoom, 3, `${d.key} 原站卫星图固定 zoom=3`);
    assert.strictEqual(L.scale, 8);
    assert.strictEqual(L.step, (Number(d.tileSize) || 256) / 8, `${d.key} 单块瓦片的边长`);
    // 网格不能退化
    assert.ok(L.x1 > L.x0 && L.y1 > L.y0, `${d.key} 瓦片网格退化了`);
    const px = mapPixelBounds(d, proj, L.scale);
    const cov = { x0: L.x0 * L.tileSize, y0: L.y0 * L.tileSize, x1: (L.x1 + 1) * L.tileSize, y1: (L.y1 + 1) * L.tileSize };
    const covered = px.minX >= cov.x0 - 1e-6 && px.minY >= cov.y0 - 1e-6 && px.maxX <= cov.x1 + 1e-6 && px.maxY <= cov.y1 + 1e-6;
    if (!KNOWN_PARTIAL.has(d.key)) {
      assert.ok(covered, `${d.key} 的 bounds 超出了瓦片网格（底图会缺一块）`);
    }
    // 不管完不完整，绝大多数标记都必须落在底图上，否则就是落位算错了
    let total = 0, outside = 0;
    for (const g of ['extracts', 'transits', 'spawns', 'lootContainers', 'lootLoose', 'locks', 'switches', 'hazards', 'stationaryWeapons', 'labels']) {
      for (const m of d[g] || []) {
        const pos = markerPos(m);
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) continue;
        total++;
        const p = proj.project(pos.x, pos.z);
        // cov 是"缩放后"的像素范围（原站画布用的那套），标记要乘 2^zoom 才能比
        const sx = p.x * L.scale, sy = p.y * L.scale;
        const inside = sx >= cov.x0 - 1e-6 && sx <= cov.x1 + 1e-6 && sy >= cov.y0 - 1e-6 && sy <= cov.y1 + 1e-6;
        if (!inside) outside++;
      }
    }
    assert.ok(total > 50, `${d.key} 应该有一批标记可查（实测 ${total} 个）`);
    const ratio = 1 - outside / total;
    const floor = KNOWN_PARTIAL.has(d.key) ? 0.6 : 0.99;
    assert.ok(ratio >= floor, `${d.key} 只有 ${(ratio * 100).toFixed(1)}% 的标记落在底图上（${outside}/${total} 在外面）`);
  }
});

test('satelliteLayout：瓦片落位与原站画布算法等价', async () => {
  const { makeProjection, satelliteLayout, mapPixelBounds } = await import('../renderer/common/map-view.js');
  for (const d of rasterMaps) {
    const proj = makeProjection(d);
    const L = satelliteLayout(d, proj);
    const ts = L.tileSize;
    const s = L.scale;
    const px = mapPixelBounds(d, proj, s);
    // 原站：画布裁到 [minX, minY]，瓦片 (x,y) 画在 (x*ts - minX, y*ts - minY)
    // 画布原点对应地图像素空间的 minX/s —— 两者一减，minX 消失，只剩 x*ts/s
    for (let x = L.x0; x <= L.x1; x++) {
      const siteLeftPx = (x * ts - px.minX + px.minX) / s;
      assert.ok(Math.abs(siteLeftPx - x * L.step) < 1e-9, `${d.key} 瓦片 x=${x} 落位不一致`);
    }
    for (let y = L.y0; y <= L.y1; y++) {
      const siteTopPx = (y * ts - px.minY + px.minY) / s;
      assert.ok(Math.abs(siteTopPx - y * L.step) < 1e-9, `${d.key} 瓦片 y=${y} 落位不一致`);
    }
    // 每块瓦片铺满 step，且整层刚好等于 8 块
    assert.ok(Math.abs(L.step * 8 - ts) < 1e-9);
  }
});

test('listMaps：实验室/迷宫/破冰船已带瓦片底图，能出现在选图列表里', () => {
  const mapsData = require('../src/maps-data');
  mapsData.load(path.join(DATA, 'maps-dump.json'), { dataRoot: DATA });
  const list = mapsData.listMaps();
  const byKey = (k) => list.find((m) => m.key === k);
  for (const key of ['the-lab', 'the-labyrinth', 'icebreaker']) {
    const m = byKey(key);
    assert.ok(m, `${key} 不在地图列表里`);
    assert.strictEqual(m.hasSvg, false, `${key} 本来就没有 SVG`);
    assert.ok(m.tiles && Object.keys(m.tiles).length > 0, `${key} 应已识别到本地瓦片`);
    assert.ok(m.hasBasemap, `${key} 应可被选图（hasBasemap）`);
  }
  // 实验室要三层（一层/二层/技术层）
  assert.strictEqual(Object.keys(byKey('the-lab').tiles).length, 3, '实验室应有 3 层瓦片');
  // 有 SVG 的图不受影响，且不会被误标成瓦片图
  const customs = byKey('customs');
  assert.ok(customs.hasSvg && customs.hasBasemap, '海关仍走 SVG');
  assert.strictEqual(customs.tiles, null, '海关没下瓦片，不应有瓦片层');
});
