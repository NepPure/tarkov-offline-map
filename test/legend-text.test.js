'use strict';

/**
 * 图例大类的「文字」开关（只看图标、不要文字）。
 *
 * 需求：地图与雷达上，**每一大类**都能单独关掉文字。两件事最容易做错，这里都盯着：
 *   1) 判定口径：标记身上带的是细分分组（extract_pmc / loot:safe / season:xxx / peer:pos:<id>），
 *      开关却按图例大类（g-extract / g-loot …）给 —— 映射漏一个，用户就会遇到"这一类怎么点
 *      都关不掉文字"（而且是静默的）。
 *   2) 接线：主窗口写完配置要广播给雷达；雷达要真的读这份配置；地图上每一处写字的地方
 *      （标记药丸、雷达药丸、队友"昵称 · 多久以前"、地名）都要过同一道闸。
 *
 * 老配置里没有 labelToggles 这个字段：缺省必须**全部写字**（行为与升级前完全一致）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const load = () => import('../renderer/common/map-view.js');

/** 本仓库里图例的全部大类 id（与 map-view.js#getLegend 里的 id: 'g-…' 对齐，下面有对账测试） */
const ALL_GROUPS = [
  'g-quest', 'g-player', 'g-anno',
  'g-room-pos', 'g-room-trail', 'g-room-anno',
  'g-extract', 'g-threat', 'g-access', 'g-hazard', 'g-season', 'g-loot', 'g-label',
];
/** 地图上只有图形、不写字的大类（组头不给 Aa 开关，图例里给一句说明） */
const NO_TEXT_GROUPS = ['g-quest', 'g-player', 'g-anno', 'g-room-trail', 'g-room-anno', 'g-label'];

test('labelToggleOff：没配 / 值不是 false -> 一律写字（老配置行为不变）', () => {
  return (async () => {
    const { labelToggleOff } = await load();
    for (const empty of [null, undefined, {}, { 'g-extract': true }, { 'g-extract': 'no' }]) {
      assert.strictEqual(labelToggleOff(empty, 'extract_pmc'), false, JSON.stringify(empty));
    }
    // 认不出的分组：不关（宁可多写一个字，也不能因为映射缺失把标记的名字吞了）
    assert.strictEqual(labelToggleOff({ 'g-extract': false }, 'unknown-group'), false);
    assert.strictEqual(labelToggleOff({ 'g-extract': false }, ''), false);
  })();
});

test('labelToggleOff：按大类关掉文字，只影响这一大类', () => {
  return (async () => {
    const { labelToggleOff } = await load();
    const off = { 'g-extract': false, 'g-loot': false };
    assert.strictEqual(labelToggleOff(off, 'extract_pmc'), true);
    assert.strictEqual(labelToggleOff(off, 'extract_scav'), true);
    assert.strictEqual(labelToggleOff(off, 'transit'), true);
    assert.strictEqual(labelToggleOff(off, 'btrStop'), true);
    assert.strictEqual(labelToggleOff(off, 'loot:safe'), true);
    assert.strictEqual(labelToggleOff(off, 'loose'), true);
    // 别的大类照旧写字
    assert.strictEqual(labelToggleOff(off, 'boss'), false);
    assert.strictEqual(labelToggleOff(off, 'lock'), false);
    assert.strictEqual(labelToggleOff(off, 'season:documents'), false);
    assert.strictEqual(labelToggleOff(off, 'label'), false);
    // 队友：位置药丸归「队友位置」，轨迹/绘图各自独立
    assert.strictEqual(labelToggleOff({ 'g-room-pos': false }, 'peer:pos:abc'), true);
    assert.strictEqual(labelToggleOff({ 'g-room-pos': false }, 'peer:trail:abc'), false);
    assert.strictEqual(labelToggleOff({ 'g-room-pos': false }, 'peer:anno:abc'), false);
  })();
});

test('legendGroupIdOf：每个图例大类都能被它自己的标记分组命中', () => {
  return (async () => {
    const { legendGroupIdOf, LEGEND_TEXT_GROUPS } = await load();
    const cases = {
      'quest:zone': 'g-quest', 'quest:spot': 'g-quest', 'quest:peer:p1': 'g-quest',
      player: 'g-player', trail: 'g-player',
      anno: 'g-anno',
      'peer:pos:p1': 'g-room-pos', 'peer:trail:p1': 'g-room-trail', 'peer:anno:p1': 'g-room-anno',
      extract_pmc: 'g-extract', extract_scav: 'g-extract', extract_shared: 'g-extract',
      transit: 'g-extract', btrStop: 'g-extract',
      boss: 'g-threat', spawn: 'g-threat',
      lock: 'g-access', switch: 'g-access',
      hazard: 'g-hazard', weapon: 'g-hazard',
      'season:documents': 'g-season',
      'loot:safe': 'g-loot', loose: 'g-loot',
      label: 'g-label',
    };
    for (const [key, gid] of Object.entries(cases)) {
      assert.strictEqual(legendGroupIdOf(key), gid, key);
      assert.ok(ALL_GROUPS.includes(gid), gid + ' 不在图例大类清单里');
    }
    // 有文字开关的大类必须都存在（改名/删组时这里会红）
    for (const gid of LEGEND_TEXT_GROUPS) assert.ok(ALL_GROUPS.includes(gid), gid + ' 不是图例大类');
  })();
});

test('对账：getLegend 里的大类 = 「有文字的」+「没文字的」，一个不漏一个不多', () => {
  return (async () => {
    const { LEGEND_TEXT_GROUPS } = await load();
    const src = read('renderer/common/map-view.js');
    const declared = [...src.matchAll(/id: '(g-[a-z-]+)'/g)].map((m) => m[1]);
    const uniq = [...new Set(declared)];
    assert.deepStrictEqual(uniq.slice().sort(), ALL_GROUPS.slice().sort(),
      'map-view.js 里的大类变了：这个清单和下面的分档要一起改');

    const withText = ALL_GROUPS.filter((g) => LEGEND_TEXT_GROUPS.has(g));
    const noText = ALL_GROUPS.filter((g) => !LEGEND_TEXT_GROUPS.has(g));
    assert.deepStrictEqual(noText.slice().sort(), NO_TEXT_GROUPS.slice().sort(),
      '没有文字的大类清单变了：图例里对它们的说明文案也要跟着改');
    // 有文字的必须真的会调用 #textOff（否则开关点了没反应）
    assert.ok(withText.length >= 5, '有文字的大类不该只剩一两个');
  })();
});

test('接线：地图上每一处写字都要过同一道闸（标记 / 雷达药丸 / 队友药丸 / 地名）', () => {
  const src = read('renderer/common/map-view.js');
  // 1) 主窗口标记药丸
  const lv = src.indexOf('#labelVisible(m) {');
  assert.ok(lv > 0, '找不到 #labelVisible');
  assert.ok(/#textOff\(m\.group\)/.test(src.slice(lv, lv + 400)), '标记文字没有过文字闸');
  // 2) 雷达的"给谁写名字"集合
  const ms = src.indexOf('#miniLabelSet(markers) {');
  assert.ok(ms > 0 && /#textOff/.test(src.slice(ms, ms + 400)), '雷达药丸没有过文字闸');
  // 3) 队友的「昵称 · 多久以前」药丸
  assert.ok(/#textOff\(`peer:pos:\$\{peer\.id\}`\)/.test(src), '队友名字药丸没有过文字闸');
  // 4) 地名：本身就是文字，关掉就不画
  assert.ok(/m\.group === 'label' && this\.#textOff\(m\.group\)/.test(src), '地名没有过文字闸');
  // 5) 开关本身：增量合并（只传变了的大类）
  assert.ok(/setLabelToggles\(toggles\)/.test(src) && /this\.labelToggles = \{ \.\.\.\(this\.labelToggles \|\| \{\}\)/.test(src),
    'setLabelToggles 不是增量合并');
});

test('接线：主窗口图例有这个开关、雷达读同一份配置、主进程会落盘', () => {
  const mapJs = read('renderer/map.js');
  const miniJs = read('renderer/minimap.js');
  const mainJs = read('main.js');
  const css = read('renderer/map.css');
  // 主窗口：组头有 Aa 勾选框，只有 group.text 才可点，改动写进配置
  assert.ok(/legend-text-box/.test(mapJs) && /legend-text-toggle/.test(mapJs), '图例组头没有 Aa 控件');
  assert.ok(/group\.text === true/.test(mapJs), '没有按 getLegend 的 text 能力决定给不给 Aa');
  assert.ok(/api\.setConfig\(\{ labelToggles: patch \}\)/.test(mapJs), 'Aa 的改动没有写进配置');
  assert.ok(/view\.setLabelToggles\(state\.cfg\.labelToggles\)/.test(mapJs), '启动时没有把配置应用到视图');
  assert.ok(/'labelToggles' in patch/.test(mapJs), '别的窗口改了配置不会反映到主地图');
  // 雷达：读配置里的同一份开关
  assert.ok(/view\.setLabelToggles\(s\.config\.labelToggles\)/.test(miniJs), '雷达没有应用文字开关');
  // 主进程：默认值 + 读存档时合并 + config:set 增量合并（不能被 patch 整体覆盖）
  assert.ok(/labelToggles: null,/.test(mainJs), '配置默认值里没有 labelToggles');
  assert.ok(/labelToggles: \{ \.\.\.defaults\.labelToggles, \.\.\.\(raw\.labelToggles \|\| \{\}\) \}/.test(mainJs),
    '读存档时没有合并 labelToggles');
  assert.ok(/const labelPatch = \(patch && patch\.labelToggles\) \|\| null;/.test(mainJs), 'config:set 没有增量合并 labelToggles');
  const setIdx = mainJs.indexOf('const labelPatch =');
  assert.ok(/labelToggles,\n/.test(mainJs.slice(setIdx, setIdx + 900)), '合并后的 labelToggles 没有写回 settings');
  // 样式：Aa 与"左边那一坨"分开点，互不影响
  assert.ok(/\.legend-group-main \{/.test(css) && /\.legend-text-toggle \{/.test(css), '组头样式没有拆成两块');
  assert.ok(/\.legend-text-toggle\.off \{/.test(css), '没有"这一类没有文字"的置灰样式');
});
