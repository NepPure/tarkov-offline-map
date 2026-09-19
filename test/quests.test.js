'use strict';

/**
 * 任务侧边栏：数据完整性 + 坐标投影 + 搜索/分组纯逻辑。
 *
 * 重点回归：
 *  1) data/quests-dump.json 里所有区域/刷新点的地图 id 都必须是我们有底图的图（否则画不出来）
 *  2) 用 src/projection.js 把区域中心投到地图像素范围里，命中率必须 >= 99%
 *     （这条曾经一次性验证了"tarkov.dev 坐标 ≈ 我们底图坐标"这个前提）
 *  3) 中文搜索 / 商人-阶段分组 / 本图过滤 的语义
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { makeProjection, mapPixelBounds } = require('../src/projection.js');

const ROOT = path.join(__dirname, '..');
const quests = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'quests-dump.json'), 'utf8'));
const mapsDump = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'maps-dump.json'), 'utf8'));
const byMapId = new Map();
for (const m of mapsDump.maps) if (m.detail && m.detail.id) byMapId.set(m.detail.id, m.detail);

const tradersById = new Map(quests.traders.map((t) => [t.id, t]));

test('任务数据：规模与中文化覆盖率', () => {
  assert.ok(quests.tasks.length > 400, `任务数偏少: ${quests.tasks.length}`);
  assert.ok(quests.traders.length >= 10, `商人偏少: ${quests.traders.length}`);

  const named = quests.tasks.filter((t) => t.name && !/^[0-9a-f]{24}/.test(t.name)).length;
  assert.ok(named / quests.tasks.length > 0.99, `中文任务名覆盖率只有 ${(named / quests.tasks.length * 100).toFixed(1)}%`);

  let objTotal = 0;
  let objNamed = 0;
  for (const t of quests.tasks) {
    for (const o of t.objectives || []) {
      objTotal++;
      if (o.text) objNamed++;
    }
  }
  assert.ok(objNamed / objTotal > 0.99, `目标描述覆盖率只有 ${(objNamed / objTotal * 100).toFixed(1)}%`);

  // 每个任务都要能归到商人 + 阶段
  for (const t of quests.tasks) {
    assert.ok(Number.isInteger(t.stage) && t.stage >= 0, `stage 非法: ${t.name}`);
    assert.ok(t.trader, `缺商人: ${t.name}`);
  }
});

test('任务数据：区域/刷新点的地图 id 都有底图', () => {
  const bad = [];
  let zones = 0;
  let spots = 0;
  for (const t of quests.tasks) {
    for (const o of t.objectives || []) {
      for (const z of o.zones || []) {
        zones++;
        if (!quests.maps[z.map]) bad.push(`zone ${t.name} -> ${z.map}`);
      }
      for (const s of o.spots || []) {
        spots++;
        if (!quests.maps[s.map]) bad.push(`spot ${t.name} -> ${s.map}`);
      }
    }
  }
  assert.ok(zones > 500, `区域数偏少: ${zones}`);
  assert.ok(spots > 200, `刷新点数偏少: ${spots}`);
  assert.deepStrictEqual(bad.slice(0, 5), [], `有区域指向没有底图的地图: ${bad.length} 处`);
});

test('任务坐标：投影后必须落在地图像素范围内（>=99%）', () => {
  let total = 0;
  let inside = 0;
  const bad = [];
  for (const t of quests.tasks) {
    for (const o of t.objectives || []) {
      for (const z of o.zones || []) {
        const detail = byMapId.get(z.map);
        if (!detail) continue;
        total++;
        const proj = makeProjection(detail);
        const b = mapPixelBounds(detail, proj);
        const p = proj.project(z.x, z.z);
        const padX = b.width * 0.02;
        const padY = b.height * 0.02;
        const ok = p.x >= b.minX - padX && p.x <= b.maxX + padX && p.y >= b.minY - padY && p.y <= b.maxY + padY;
        if (ok) inside++;
        else bad.push(`${t.name}@${detail.key} ${z.x},${z.z} -> ${p.x.toFixed(0)},${p.y.toFixed(0)} box[${b.minX.toFixed(0)},${b.minY.toFixed(0)},${b.maxX.toFixed(0)},${b.maxY.toFixed(0)}]`);
      }
    }
  }
  const ratio = inside / total;
  assert.ok(total > 500, `参与校验的区域太少: ${total}`);
  assert.ok(ratio >= 0.99, `投影命中率 ${(ratio * 100).toFixed(1)}% 过低，前几例: ${bad.slice(0, 3).join(' | ')}`);
});

test('任务区域：轮廓点都成对且能闭合', () => {
  let polys = 0;
  for (const t of quests.tasks) {
    for (const o of t.objectives || []) {
      for (const z of o.zones || []) {
        assert.ok(Number.isFinite(z.x) && Number.isFinite(z.z), `区域坐标非法: ${t.name}`);
        if (!z.outline) continue;
        polys++;
        assert.ok(z.outline.length >= 3, `轮廓点太少: ${t.name}`);
        for (const pt of z.outline) {
          assert.ok(Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite), `轮廓点非法: ${t.name}`);
        }
      }
    }
  }
  assert.ok(polys > 100, `带轮廓的区域太少: ${polys}`);
});

test('搜索：中文子串 / 多词 AND / 商人名 / 空查询', async () => {
  const { matchesQuery, filterTasks } = await import('../renderer/common/quest-filter.js');
  const sample = quests.tasks.find((t) => t.name.includes('新手上路')) || quests.tasks[0];
  const trader = tradersById.get(sample.trader);

  assert.strictEqual(matchesQuery(sample, '', trader), true, '空查询应全部命中');
  assert.strictEqual(matchesQuery(sample, sample.name.slice(0, 2), trader), true, '中文子串应命中');
  assert.strictEqual(matchesQuery(sample, '不存在的任务名xyz', trader), false);
  assert.strictEqual(matchesQuery(sample, trader.name, trader), true, '商人中文名应命中');

  // 多词 AND：一个词命中名称、另一个命中目标文字
  const target = quests.tasks.find((t) => t.objectives.some((o) => o.text && o.text.length > 4));
  const word = target.objectives.find((o) => o.text).text.slice(0, 2);
  const res = filterTasks([target], tradersById, { query: `${target.name.slice(0, 2)} ${word}`, mapOnly: false, locationOnly: false });
  assert.strictEqual(res.length, 1, '多词 AND 应按预期命中');
  const res2 = filterTasks([target], tradersById, { query: `${target.name.slice(0, 2)} zzzz`, mapOnly: false, locationOnly: false });
  assert.strictEqual(res2.length, 0, '有一个词不命中就不该出现');
});

test('阶段分档：深度 -> 起始/前期/中期/后期/终局', async () => {
  const { stageBucket, STAGE_BUCKETS } = await import('../renderer/common/quest-filter.js');
  assert.strictEqual(stageBucket(0).label, '起始');
  assert.strictEqual(stageBucket(1).label, '前期');
  assert.strictEqual(stageBucket(2).label, '前期');
  assert.strictEqual(stageBucket(3).label, '中期');
  assert.strictEqual(stageBucket(5).label, '中期');
  assert.strictEqual(stageBucket(6).label, '后期');
  assert.strictEqual(stageBucket(10).label, '后期');
  assert.strictEqual(stageBucket(11).label, '终局');
  assert.strictEqual(stageBucket(99).label, '终局');
  assert.strictEqual(STAGE_BUCKETS.length, 5);
  // 连续覆盖，无空洞
  for (let s = 0; s <= 30; s++) assert.ok(stageBucket(s), `stage ${s} 没归到档位`);
});

test('分组：商人 -> 阶段，组内按等级/名称有序', async () => {
  const { groupTasks, stageBucket } = await import('../renderer/common/quest-filter.js');
  const groups = groupTasks(quests.tasks, tradersById);
  assert.ok(groups.length >= 10, `商人群组偏少: ${groups.length}`);
  const sum = groups.reduce((n, g) => n + g.count, 0);
  assert.strictEqual(sum, quests.tasks.length, '分组不能丢任务');

  for (const g of groups) {
    assert.ok(g.trader.name, '商人必须有名字');
    const orders = g.stages.map((s) => s.order);
    assert.deepStrictEqual(orders, [...orders].sort((a, b) => a - b), '阶段必须按顺序');
    for (const s of g.stages) {
      for (const t of s.tasks) assert.strictEqual(stageBucket(t.stage).order, s.order, `${t.name} 放错阶段`);
      for (let i = 1; i < s.tasks.length; i++) {
        const a = s.tasks[i - 1];
        const b = s.tasks[i];
        assert.ok((a.level || 0) < (b.level || 0) || ((a.level || 0) === (b.level || 0)), '组内应按等级升序');
      }
    }
  }
});

test('筛选：本图 / 只看有地点 / 击杀区默认不算地点', async () => {
  const { filterTasks, taskHasLocation } = await import('../renderer/common/quest-filter.js');
  const mapId = '56f40101d2720b2a4d8b45d6'; // customs

  const onMap = filterTasks(quests.tasks, tradersById, { mapId, mapOnly: true, locationOnly: false });
  assert.ok(onMap.length > 20, `海关任务偏少: ${onMap.length}`);
  for (const t of onMap) assert.ok(t.maps.includes(mapId), `${t.name} 不该出现在海关`);

  const located = filterTasks(quests.tasks, tradersById, { mapId, mapOnly: true, locationOnly: true });
  assert.ok(located.length > 5 && located.length <= onMap.length);
  for (const t of located) assert.ok(taskHasLocation(t, mapId, { showKill: false }), `${t.name} 没有可画地点`);

  // 只看击杀区的任务：默认被排除，打开 showKill 后应重新出现
  const killOnly = quests.tasks.find(
    (t) => t.maps.includes(mapId) && t.objectives.every((o) => o.type === 'shoot'),
  );
  if (killOnly) {
    const off = filterTasks([killOnly], tradersById, { mapId, mapOnly: true, locationOnly: true, showKill: false });
    const on = filterTasks([killOnly], tradersById, { mapId, mapOnly: true, locationOnly: true, showKill: true });
    assert.strictEqual(off.length, 0, `纯击杀任务默认不该算"有地点": ${killOnly.name}`);
    if (killOnly.objectives.some((o) => (o.zones || []).length)) {
      assert.strictEqual(on.length, 1, `打开击杀区后应出现: ${killOnly.name}`);
    }
  }
});

test('筛选：已勾选 / 商人 / 等级上限', async () => {
  const { filterTasks } = await import('../renderer/common/quest-filter.js');
  const a = quests.tasks[0];
  const b = quests.tasks.find((t) => t.trader !== a.trader);

  const checked = new Set([a.id]);
  const only = filterTasks(quests.tasks, tradersById, { checkedOnly: true, checked, mapOnly: false, locationOnly: false });
  assert.deepStrictEqual(only.map((t) => t.id), [a.id]);

  const byTrader = filterTasks(quests.tasks, tradersById, { traderId: b.trader, mapOnly: false, locationOnly: false });
  assert.ok(byTrader.length > 0);
  for (const t of byTrader) assert.strictEqual(t.trader, b.trader);

  const lowLevel = filterTasks(quests.tasks, tradersById, { levelMax: 10, mapOnly: false, locationOnly: false });
  for (const t of lowLevel) assert.ok((t.level || 0) <= 10);
  assert.ok(lowLevel.length < quests.tasks.length);
});

test('任务物品/钥匙：中文名可离线解析', () => {
  assert.ok(quests.items && Object.keys(quests.items).length > 1000, `物品名字典太小: ${Object.keys(quests.items || {}).length}`);
  // 任务真正引用到的 id 里，绝大多数要有中文名（少数是任务专用占位物品）
  const refs = new Set();
  for (const t of quests.tasks) {
    for (const o of t.objectives || []) {
      if (o.item) refs.add(o.item);
      for (const i of o.itemIds || []) refs.add(i);
      for (const grp of o.requiredKeys || []) for (const k of grp || []) refs.add(k);
    }
  }
  const named = [...refs].filter((id) => quests.items[id]).length;
  assert.ok(refs.size > 500, `引用物品偏少: ${refs.size}`);
  // 约 13% 是 tarkov.dev 物品表里没有的任务专用物品（详情卡会显示"未收录物品(短id)"）
  assert.ok(named / refs.size > 0.85, `物品名覆盖率只有 ${((named / refs.size) * 100).toFixed(1)}%`);

  // 钥匙要能解析成中文（详情卡直接显示这个）
  const withKey = quests.tasks.find((t) => (t.objectives || []).some((o) => (o.requiredKeys || []).length));
  assert.ok(withKey, '没有找到带钥匙要求的任务');
  const keyId = withKey.objectives.find((o) => (o.requiredKeys || []).length).requiredKeys[0][0];
  assert.ok(quests.items[keyId], `钥匙 ${keyId} 没有中文名`);
  assert.ok(/[\u4e00-\u9fa5]/.test(quests.items[keyId]), `钥匙名不是中文: ${quests.items[keyId]}`);
});

test('详情卡：目标里引用的物品/钥匙都能查到名字或退化成 id', async () => {
  const { taskLocation } = await import('../renderer/common/quest-filter.js');
  const mapId = '56f40101d2720b2a4d8b45d6';
  // 找一个"在本图有区域、且目标带钥匙或物品"的任务，模拟详情卡取数
  const task = quests.tasks.find((t) =>
    t.objectives.some((o) => (o.requiredKeys || []).length && (o.zones || []).some((z) => z.map === mapId)),
  ) || quests.tasks.find((t) => (t.objectives || []).some((o) => o.item));
  assert.ok(task, '没有带钥匙/物品的目标');
  const loc = taskLocation(task, mapId, { showKill: true });
  const obj = task.objectives.find((o) => (o.requiredKeys || []).length) || task.objectives[0];
  const names = [];
  if (obj.item) names.push(quests.items[obj.item] || obj.item);
  for (const grp of obj.requiredKeys || []) for (const k of grp || []) names.push(quests.items[k] || k);
  for (const n of names) assert.ok(n && typeof n === 'string', '物品名解析失败');
  assert.ok(loc.zones.length >= 0);
});

test('摘要：有地点显示地点数，无地点提示仅文字', async () => {
  const { taskSummary } = await import('../renderer/common/quest-filter.js');
  const mapId = '56f40101d2720b2a4d8b45d6';
  const withZones = quests.tasks.find((t) => t.objectives.some((o) => (o.zones || []).some((z) => z.map === mapId)));
  if (withZones) {
    const s = taskSummary(withZones, mapId, quests.maps);
    assert.ok(/地点/.test(s), `摘要应提到地点: ${s}`);
  }
  const noLoc = quests.tasks.find((t) => t.objectives.length && t.objectives.every((o) => !(o.zones || []).length && !(o.spots || []).length));
  if (noLoc) {
    const s = taskSummary(noLoc, mapId, quests.maps);
    assert.ok(/无地点/.test(s), `摘要应提示没有地点: ${s}`);
  }
});

// 真实反馈：勾了"铁鸟坠落"（位置在森林），但当时地图停在灯塔 -> 地图上什么都没出现，
// 用户以为功能坏了。所以要能算出"这个任务的位置在哪些图"，界面才能明确提示并给出切图按钮。
test('位置在别的图：能算出任务的可画地图，且本图无位置时能指路', async () => {
  const { locationsByMap, otherMapsWithLocation, taskLocation } = await import('../renderer/common/quest-filter.js');
  const woods = '5704e3c2d2720bac5b8b4567';
  const lighthouse = '5704e554d2720bac5b8b456e';

  const t = quests.tasks.find((x) => x.id === '5b4794cb86f774598100d5d4');
  assert.ok(t, '数据集里应该有"铁鸟坠落"');
  const byMap = locationsByMap(t);
  assert.deepStrictEqual(byMap.map((m) => m.mapId), [woods], '它的位置只在森林');
  assert.strictEqual(byMap[0].spots, 2, '铁鸟坠落有 2 个刷新点');

  // 在灯塔看：本图没位置、别图有 -> otherMapsWithLocation 必须指出森林
  assert.strictEqual(taskLocation(t, lighthouse, { showKill: true }).spots.length, 0);
  assert.deepStrictEqual(otherMapsWithLocation(t, lighthouse, { showKill: true }).map((m) => m.mapId), [woods]);

  // 在森林看：本图就有 -> 没有"别的图"
  assert.strictEqual(taskLocation(t, woods, { showKill: true }).spots.length, 2);
  assert.strictEqual(otherMapsWithLocation(t, woods, { showKill: true }).length, 0);

  // 击杀类目标计入与否跟着"击杀区"开关走
  const killTask = quests.tasks.find((x) => x.objectives.some((o) => o.type === 'shoot' && (o.zones || []).length));
  assert.ok(killTask, '应该存在带区域的击杀任务');
  const off = locationsByMap(killTask, { showKill: false }).reduce((n, m) => n + m.zones, 0);
  const on = locationsByMap(killTask, { showKill: true }).reduce((n, m) => n + m.zones, 0);
  assert.ok(on > off, '打开"击杀区"后能画的区域应该变多');

  // 数据集里"有坐标的任务"占比很低，这是公开数据的客观情况，界面必须靠提示解释
  const withLoc = quests.tasks.filter((x) => locationsByMap(x, { showKill: true }).length).length;
  assert.ok(withLoc / quests.tasks.length > 0.3, `有坐标的任务太少: ${withLoc}/${quests.tasks.length}`);
  assert.ok(withLoc / quests.tasks.length < 0.8, `有坐标的任务异常地多: ${withLoc}/${quests.tasks.length}`);
});
