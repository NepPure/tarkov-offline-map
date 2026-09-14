'use strict';

/**
 * 赛季文件刷点数据完整性测试
 * 数据由 tools/fetch-season.js 生成，用于"版本活动在地图上找东西"的离线标点。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const season = JSON.parse(fs.readFileSync(path.join(DATA, 'season-documents.json'), 'utf8'));
const dump = JSON.parse(fs.readFileSync(path.join(DATA, 'maps-dump.json'), 'utf8'));

test('赛季文件类型：8 类且带中文名与图标', () => {
  const types = Object.values(season.types);
  assert.strictEqual(types.length, 8, '应有 8 种赛季文件');
  for (const t of types) {
    assert.ok(t.name && /[\u4e00-\u9fa5]/.test(t.name), `${t.type} 缺中文名`);
    assert.ok(t.shortName, `${t.type} 缺短名`);
    assert.ok(t.icon, `${t.type} 缺图标字段`);
    assert.ok(fs.existsSync(path.join(DATA, 'icons', t.icon)), `${t.icon} 图标文件缺失`);
  }
  assert.deepStrictEqual(
    new Set(types.map((t) => t.type)),
    new Set(['pmc', 'medical', 'finances', 'employee', 'technical', 'blueprints', 'test', 'project'])
  );
});

test('赛季文件刷点：数量与字段完整', () => {
  assert.ok(season.total > 100, `刷点总数异常: ${season.total}`);
  assert.strictEqual(season.season, 1);
  let n = 0;
  for (const [mapId, entry] of Object.entries(season.maps)) {
    assert.ok(entry.key && entry.name, `${mapId} 缺地图信息`);
    assert.ok(entry.points.length > 0);
    for (const p of entry.points) {
      n++;
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), `${mapId} 坐标非法`);
      assert.ok(season.types[p.itemId], `${mapId} 刷点类型未知: ${p.itemId}`);
      assert.ok(p.uuid, `${mapId} 刷点缺 uuid`);
    }
  }
  assert.strictEqual(n, season.total, 'total 与实际点数不一致');
});

test('赛季文件刷点：坐标基本落在地图 bounds 内（社区提交存在少量越界点）', () => {
  const byId = new Map(dump.maps.map((m) => [m.detail.id, m.detail]));
  let inside = 0, total = 0;
  const outliers = [];
  for (const [mapId, entry] of Object.entries(season.maps)) {
    const detail = byId.get(mapId);
    assert.ok(detail, `地图数据缺失: ${entry.name}`);
    const [[x1, z1], [x2, z2]] = detail.bounds;
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
    for (const p of entry.points) {
      total++;
      if (p.x >= minX && p.x <= maxX && p.z >= minZ && p.z <= maxZ) inside++;
      else outliers.push(`${entry.name} (${p.x}, ${p.z})`);
    }
  }
  const ratio = inside / total;
  assert.ok(ratio >= 0.97, `bounds 命中率过低 ${(ratio * 100).toFixed(1)}%: ${outliers.slice(0, 5).join('; ')}`);
  if (outliers.length) console.log(`[season] ${outliers.length}/${total} 个刷点超出底图 bounds（上游社区数据）`);
});

test('赛季文件刷点：每个点都能离线看到位置参考截图', () => {
  const imgDir = path.join(DATA, 'season-images');
  assert.ok(fs.existsSync(imgDir), 'data/season-images 目录缺失（运行 npm run fetch:season:images）');
  let n = 0, missing = [];
  for (const entry of Object.values(season.maps)) {
    for (const p of entry.points) {
      n++;
      if (!p.imageLocal) { missing.push(`${p.uuid} 缺 imageLocal`); continue; }
      const f = path.join(DATA, p.imageLocal);
      if (!fs.existsSync(f) || fs.statSync(f).size < 1024) missing.push(p.imageLocal);
    }
  }
  assert.deepStrictEqual(missing.slice(0, 5), [], `${missing.length} 张参考截图缺失`);
  assert.strictEqual(n, season.total);
  assert.ok(season.images && season.images.count >= 400, '缺少 images 元数据');
});

test('地图数据包含 1.1.5.0 新增的 BTR 站点', () => {
  const btr = dump.maps.filter((m) => (m.detail.btrStops || []).length > 0);
  const keys = btr.map((m) => m.detail.key);
  assert.ok(keys.includes('lighthouse'), '灯塔应有 BTR 站点（1.1.5.0 新增）');
  assert.ok(keys.includes('woods') && keys.includes('streets-of-tarkov'));
  for (const m of btr) {
    for (const s of m.detail.btrStops) {
      assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z), `${m.detail.key} BTR 站点坐标非法`);
      assert.ok(s.name, `${m.detail.key} BTR 站点缺中文名`);
    }
  }
});
