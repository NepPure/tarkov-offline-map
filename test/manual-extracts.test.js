'use strict';

/**
 * 人工补录点位（data/manual-extracts.json）回归测试。
 *
 * 背景：上游地图数据（kaedeori 站台 / tarkov.dev）本身有缺漏——灯塔少了
 * 「通往军事基地的路（载具撤离点）」等 5 条游戏内真实存在的撤离点。
 * 补录写在 overlay 文件里，由 src/maps-data.js 在加载时合并。
 *
 * 这个测试盯三件事：
 *  1. overlay 文件结构合法（id 唯一、坐标/轮廓齐全、来源标注齐全）
 *  2. 合并真的生效（灯塔撤离点从 8 条变成 13 条，载具撤离点在列）
 *  3. 合并是幂等的（重复 load 不会越加越多），且上游将来补齐后不会重复
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const OVERLAY = path.join(REPO, 'data', 'manual-extracts.json');
const DUMP = path.join(REPO, 'data', 'maps-dump.json');
const LIGHTHOUSE = '5704e4dad2720bb55b8b4567';

function freshData() {
  // 每次重新 require，避免模块级 DATA 缓存互相影响
  delete require.cache[require.resolve('../src/maps-data')];
  return require('../src/maps-data');
}

test('overlay 文件存在且结构合法', () => {
  assert.ok(fs.existsSync(OVERLAY), 'data/manual-extracts.json 应该存在');
  const ov = JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
  assert.strictEqual(typeof ov.maps, 'object');
  assert.ok(ov._note && ov._note.length > 10, '应该有 _note 说明为什么要有这个文件');

  const seen = new Set();
  let entries = 0;
  for (const [mapId, perMap] of Object.entries(ov.maps)) {
    assert.match(mapId, /^[0-9a-f]{24}$/, `${mapId} 应该是地图 id`);
    for (const [key, list] of Object.entries(perMap)) {
      if (key.startsWith('_')) continue;
      assert.ok(Array.isArray(list), `${mapId}.${key} 应该是数组`);
      for (const it of list) {
        entries++;
        assert.ok(it.id, '每条都要有稳定 id');
        assert.ok(it.id.startsWith('manual-'), `${it.id} 应以 manual- 前缀（一眼看出是补录的）`);
        assert.ok(!seen.has(it.id), `id 重复: ${it.id}`);
        seen.add(it.id);
        assert.ok(it.name && it.name.length > 1, `${it.id} 缺 name`);
        assert.ok(it.sourceName, `${it.id} 缺 sourceName（要能追溯来源）`);
        assert.ok(/^https?:\/\//.test(it.sourceUrl || ''), `${it.id} 缺 sourceUrl`);
      }
      if (key === 'extracts') {
        for (const e of list) {
          assert.ok(['pmc', 'scav', 'shared', 'pmc/scav'].includes(e.faction), `${e.id} faction 非法: ${e.faction}`);
          assert.ok(Number.isFinite(e.position.x) && Number.isFinite(e.position.z), `${e.id} 缺坐标`);
          assert.strictEqual(e.outline.length, 4, `${e.id} 轮廓应该是 4 个角`);
          for (const c of e.outline) assert.ok(Number.isFinite(c.x) && Number.isFinite(c.z), `${e.id} 轮廓坐标非法`);
          assert.ok(Number.isFinite(e.top) && Number.isFinite(e.bottom), `${e.id} 缺 top/bottom`);
        }
      }
    }
  }
  assert.ok(entries >= 5, `补录条目应该 >=5，实际 ${entries}`);
});

test('加载后灯塔撤离点包含载具撤离点（上游缺失的点位被合并进来）', () => {
  const md = freshData();
  const raw = JSON.parse(fs.readFileSync(DUMP, 'utf8')).maps.find((m) => m.id === LIGHTHOUSE).detail;
  const before = raw.extracts.length;

  md.load(DUMP, { dataRoot: path.join(REPO, 'data') });
  const lh = md.getById(LIGHTHOUSE);
  assert.strictEqual(lh.extracts.length, before + 5, `合并后应为 ${before + 5} 条`);
  assert.strictEqual(lh.transits.length, 3, '转移点不该被动到');

  const vex = lh.extracts.find((e) => /载具撤离点/.test(e.name));
  assert.ok(vex, '灯塔应该有载具撤离点');
  assert.strictEqual(vex.faction, 'pmc');
  // 换算出来的位置应该落在「通往储备站」转移点附近（那条路就是通往军事基地的路）
  const toReserve = lh.transits.find((t) => /储备站/.test(t.description));
  const d = Math.hypot(vex.position.x - toReserve.position.x, vex.position.z - toReserve.position.z);
  assert.ok(d < 120, `载具撤离点应靠近通往储备站的路口，实际相距 ${d.toFixed(1)}m`);

  // 每个 faction 都该有新增
  const by = {};
  for (const e of lh.extracts) by[e.faction] = (by[e.faction] || 0) + 1;
  assert.deepStrictEqual(by, { shared: 2, scav: 5, pmc: 6 }, `faction 分布应为 {shared:2, scav:5, pmc:6}，实际 ${JSON.stringify(by)}`);
  assert.ok(md.manualStats().applied >= 5);
});

test('合并幂等：重复 load 不会重复累积', () => {
  const md = freshData();
  md.load(DUMP, { dataRoot: path.join(REPO, 'data') });
  const n1 = md.getById(LIGHTHOUSE).extracts.length;
  md.load(DUMP, { dataRoot: path.join(REPO, 'data') });
  const n2 = md.getById(LIGHTHOUSE).extracts.length;
  assert.strictEqual(n1, n2, '重复加载条数应该一致');
});

test('上游补齐后自动跳过（同 id 不再重复插入）', () => {
  const md = freshData();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-overlay-'));
  try {
    const dump = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
    const lh = dump.maps.find((m) => m.id === LIGHTHOUSE).detail;
    const ov = JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
    // 模拟"上游自己补上了这条"：直接把补录项塞进 dump
    const injected = ov.maps[LIGHTHOUSE].extracts[0];
    lh.extracts.push(JSON.parse(JSON.stringify(injected)));
    const dumpPath = path.join(tmp, 'maps-dump.json');
    fs.writeFileSync(dumpPath, JSON.stringify(dump));
    fs.copyFileSync(OVERLAY, path.join(tmp, 'manual-extracts.json'));

    md.load(dumpPath, { dataRoot: tmp });
    const ids = md.getById(LIGHTHOUSE).extracts.map((e) => e.id);
    const dup = ids.filter((id) => id === injected.id).length;
    assert.strictEqual(dup, 1, '同 id 只应出现一次');
    assert.ok(md.manualStats().skipped >= 1, '应记录跳过的条数');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('overlay 文件缺失时不影响加载', () => {
  const md = freshData();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'takov-overlay-none-'));
  try {
    fs.copyFileSync(DUMP, path.join(tmp, 'maps-dump.json'));
    md.load(path.join(tmp, 'maps-dump.json'), { dataRoot: tmp });
    assert.strictEqual(md.manualStats().applied, 0);
    assert.strictEqual(md.getById(LIGHTHOUSE).extracts.length, 8, '没有 overlay 就是上游原始 8 条');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
