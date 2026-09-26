'use strict';

/**
 * 雷达（圆形小地图）与主地图的"图上一致"：
 *   1) 主窗口勾选的任务点（区域 / 物品刷新点）在雷达上也要画 —— 同一份离线任务库 +
 *      同一份勾选状态，两边各算一遍，但算法同一套。
 *   2) 雷达上的字不会"整体消失"：上限裁剪与"给谁写名字"都改成
 *      按重要度 + 离圆心距离挑，绝不整类丢、更不会一个名字都不写。
 *
 * 纯函数直接断言；接线部分按项目习惯做静态检查（这几处断了的表现就是"界面上没反应"）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const mk = (group, d) => ({ group, _miniD: d });

test('雷达标记优先级：赛季文件 > 撤离点 > Boss > BTR > 转移点 > 钥匙/开关 > 地名 > 散落物资/物资箱', () => {
  return (async () => {
    const { miniMarkerRank } = await import('../renderer/common/map-view.js');
    const order = ['season:document', 'extract_pmc', 'boss', 'btrStop', 'transit', 'lock', 'label', 'loose', 'loot:crate'];
    const ranks = order.map(miniMarkerRank);
    for (let i = 1; i < ranks.length; i++) {
      assert.ok(ranks[i - 1] < ranks[i], `${order[i - 1]} 应该比 ${order[i]} 重要`);
    }
    // 同类同优先级（PMC/Scav/共享撤离点都是撤离点）
    assert.strictEqual(miniMarkerRank('extract_scav'), miniMarkerRank('extract_shared'));
    // 认不出的分组不许是 NaN（会污染排序）
    assert.ok(Number.isFinite(miniMarkerRank(undefined)) && Number.isFinite(miniMarkerRank('什么鬼')));
  })();
});

test('雷达上限裁剪：超限只丢最不重要的，地名不会被整类丢掉，且保持原顺序', () => {
  return (async () => {
    const { trimMiniMarkers } = await import('../renderer/common/map-view.js');

    const markers = [];
    for (let i = 0; i < 10; i++) markers.push(mk('label', i));        // 地名（近的在前）
    for (let i = 0; i < 5; i++) markers.push(mk('loot:crate', i));    // 物资箱
    markers.push(mk('extract_pmc', 500));                             // 关键标记，但很远
    const out = trimMiniMarkers(markers, 6);

    assert.strictEqual(out.length, 6);
    assert.ok(out.includes(markers[15]), '撤离点再远也要留');
    assert.strictEqual(out.filter((m) => m.group === 'label').length, 5, '地名要保留最近的 5 个');
    assert.ok(out.includes(markers[4]) && !out.includes(markers[5]), '同类里先丢远的');
    assert.ok(!out.some((m) => m.group.startsWith('loot:')), '物资箱先丢');
    // 画上去的先后不变（重叠时谁压谁是稳定的）：返回顺序 = 原数组顺序的子序列
    const idx = out.map((m) => markers.indexOf(m));
    assert.deepStrictEqual(idx, [...idx].sort((a, b) => a - b));

    // 回归：旧实现"第一刀先把全部地名丢掉"，于是密集区里雷达上的字会整体消失
    const dense = [mk('label', 3)];
    for (let i = 0; i < 100; i++) dense.push(mk('loot:crate', i));
    const kept = trimMiniMarkers(dense, 10);
    assert.ok(kept.some((m) => m.group === 'label'), '地名不能因为"整类先丢"而消失');

    // 没超上限 / 参数不合法：原样返回，绝不抛
    const few = [mk('label', 0)];
    assert.strictEqual(trimMiniMarkers(few, 6), few);
    assert.deepStrictEqual(trimMiniMarkers(null, 5), []);
    assert.strictEqual(trimMiniMarkers(few, 0), few);
  })();
});

test('雷达标名：超过上限取"最重要的 + 最近的"，绝不返回空集合', () => {
  return (async () => {
    const { pickMiniLabeled } = await import('../renderer/common/map-view.js');

    const list = [
      mk('extract_pmc', 40), mk('extract_scav', 5), mk('boss', 200), mk('btrStop', 3),
      mk('transit', 9), mk('season:document', 60), mk('label', 0), mk('loot:crate', 1),
    ];
    const set = pickMiniLabeled(list, 3);
    assert.strictEqual(set.size, 3);
    assert.ok(set.has(list[5]), '赛季文件优先');
    assert.ok(set.has(list[1]), '同类里取最近的撤离点');
    assert.ok(!set.has(list[6]) && !set.has(list[7]), '地名/物资箱不走"标名"这条路');
    // 没超上限：该标的都标
    assert.strictEqual(pickMiniLabeled(list.slice(0, 2), 6).size, 2);

    // 回归：旧实现超过 6 个直接 return null（一个名字都不写）——走进密集区字就没了
    const many = [];
    for (let i = 0; i < 30; i++) many.push(mk('extract_pmc', i));
    const picked = pickMiniLabeled(many, 6);
    assert.ok(picked instanceof Set, '永远返回集合，不返回 null');
    assert.strictEqual(picked.size, 6);
    assert.ok(picked.has(many[0]) && picked.has(many[5]) && !picked.has(many[29]), '取最近的 6 个');
    // 不传上限也有默认上限
    const def = pickMiniLabeled(many);
    assert.ok(def.size > 0 && def.size <= 6);
    // 脏数据不抛
    assert.strictEqual(pickMiniLabeled(null).size, 0);
    assert.strictEqual(pickMiniLabeled([null, undefined]).size, 0);
  })();
});

test('接线：雷达画"主窗口勾选的任务点"，并用同一份配置（勾选/透明度/地图名/表层标记）', () => {
  const mv = read('renderer/common/map-view.js');
  const mm = read('renderer/minimap.js');
  const mj = read('renderer/map.js');

  // map-view：两处"整类消失"的旧逻辑必须清干净
  assert.ok(mv.includes('return pickMiniLabeled(markers)'), '雷达标名要走"挑最近的若干个"');
  assert.ok(!mv.includes('key.length > 6) return null'), '旧的"超过 6 个就一个名字都不写"必须删掉');
  assert.ok(mv.includes('trimMiniMarkers(picks, MINI_SOFT_CAP)'), '软上限要用按重要度+距离裁剪');
  assert.ok(!mv.includes('dropStages'), '旧的"分级整类丢弃"必须删掉');

  // 雷达侧接线
  assert.match(mm, /import \{[^}]*taskLocation[^}]*\} from '\.\/common\/quest-filter\.js'/, '雷达要用主窗口同一套任务定位算法');
  assert.ok(mm.includes('view.setQuests(items)'), '雷达要把任务点交给图层');
  assert.ok(mm.includes("fetch('app://data/quests-dump.json')"), '任务数据要和主窗口读同一份离线快照');
  assert.ok(mm.includes('questCfg.checked') && mm.includes('q.checked'), '勾选状态要来自配置');
  assert.ok(mm.includes('showKill'), '击杀区开关也要跟着配置（否则两边画的东西不一样）');
  assert.ok(mm.includes('view.setQuestOpacity'), '区域透明度要和主窗口一致');
  assert.ok(mm.includes('view.setMapNames'), '转移点文字要补中文目的地（否则雷达上只剩"前往"）');
  assert.ok(mm.includes('view.setShowAllHeights'), '"表层显示全部标记"要和主窗口一致');
  assert.ok(mm.includes('maybeSyncQuests'), '要按指纹去重，别每条状态推送都重算图层');
  assert.ok(mm.includes('MAX_MINI_QUESTS'), '一张图上的任务数量要有上限（和主窗口一致）');

  // 主进程：窗口刚起来（state:get）就得带配置，否则雷达第一帧没有勾选状态
  assert.match(read('main.js'), /state:get'[\s\S]{0,220}?config: settings/, 'state:get 要带 config');
  // 渲染层：勾选后写回配置，雷达靠这次广播更新
  assert.ok(mj.includes('checked: [...quest.checked]'), '勾选要存进配置');
});
