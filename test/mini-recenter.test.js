'use strict';

/**
 * 雷达「新的一次定位必须重新居中」+ 尺寸/半径实时重算。
 *
 * 用户报的：拖动雷达（Ctrl 拖动平移过圆盘里的地图）之后，再按截图键定位，
 * 玩家停在偏心位置不再回到圆心。修法是：位置**真的变了**时把视野偏移归零。
 * 这里既测那条判定规则，也做几处静态接线检查（改坏了很难从界面上看出来）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

test('第一次定位 / 位置真的变了 -> 要重新居中', () => {
  return (async () => {
    const { shouldRecenterOnPosition } = await import('../renderer/common/map-view.js');
    assert.strictEqual(shouldRecenterOnPosition(null, { x: 100, z: 200 }, true), true);
    assert.strictEqual(shouldRecenterOnPosition({ x: 1, z: 2 }, { x: 5, z: 6 }, true), true);
  })();
});

test('同一次定位（浮点噪声）-> 不要把用户平移出来的视野拉回去', () => {
  return (async () => {
    const { shouldRecenterOnPosition, POS_EPS } = await import('../renderer/common/map-view.js');
    assert.strictEqual(shouldRecenterOnPosition({ x: 10, z: 10 }, { x: 10, z: 10 }, true), false);
    assert.strictEqual(shouldRecenterOnPosition({ x: 10, z: 10 }, { x: 10 + POS_EPS / 2, z: 10 }, true), false);
    assert.strictEqual(shouldRecenterOnPosition({ x: 10, z: 10 }, { x: 10, z: 10 + POS_EPS / 2 }, true), false);
    // 只挪了高度（y）不算换位置 —— 视野是俯视的
    assert.strictEqual(shouldRecenterOnPosition({ x: 10, y: 1, z: 10 }, { x: 10, y: 9, z: 10 }, true), false);
  })();
});

test('关掉「定位后自动居中」时，一次也不许抢回视野', () => {
  return (async () => {
    const { shouldRecenterOnPosition } = await import('../renderer/common/map-view.js');
    assert.strictEqual(shouldRecenterOnPosition(null, { x: 1, z: 1 }, false), false);
    assert.strictEqual(shouldRecenterOnPosition({ x: 1, z: 1 }, { x: 9, z: 9 }, false), false);
    // 没有位置（新一局清空）也不用居中
    assert.strictEqual(shouldRecenterOnPosition({ x: 1, z: 1 }, null, true), false);
  })();
});

test('接线：雷达在"新定位"时归零视野偏移，并只在位置真的变了时做', () => {
  const js = read('renderer/minimap.js');
  const at = js.indexOf('shouldRecenterOnPosition(prev');
  assert.ok(at > 0, 'minimap.js 里没有用 shouldRecenterOnPosition 判定"新的一次定位"');
  const block = js.slice(at, at + 400);
  assert.ok(/panOffset\.x = 0/.test(block) && /panOffset\.y = 0/.test(block),
    '判定通过后必须把视野偏移归零，否则玩家还是停在偏心位置');
  // 判定必须拿"上一个位置"比，而不是无条件归零（否则 Ctrl 平移会被下一次状态推送立刻撤销）
  assert.ok(/const prev = view\.player/.test(js), '没有记下"定位前"的玩家位置，没法判断是不是新的一次定位');
  assert.ok(/shouldRecenterOnPosition/.test(read('renderer/common/map-view.js')), 'map-view.js 里没有导出这个判定');
});

test('接线：窗口大小 / 显示半径变了要按新半径重新铺满圆盘', () => {
  const js = read('renderer/minimap.js');
  assert.ok(/function refitRadius\(/.test(js), '缺少 refitRadius（只重算缩放、不动视野中心）');
  assert.ok(/radiusDirty = true/.test(js), '显示半径变化没有被标记（拖滑块要等下一次定位才生效）');
  assert.ok(/addEventListener\('resize'/.test(js), '窗口大小变了没有重新适配圆盘半径');
  assert.ok(/refitRadius\(\)/.test(js), 'resize 处理里没有重新适配半径');
  // 自检钩子（CDP 验收脚本要用）
  assert.ok(/window\.__mini = \{/.test(js), '缺少 window.__mini 自检钩子');
  assert.ok(/discWidth:/.test(js) && /setPan:/.test(js), 'window.__mini 缺少 discWidth / setPan');
});

test('接线：雷达尺寸不再是写死的常量（拖动、看门狗、钳制共用一份）', () => {
  const main = read('main.js');
  assert.ok(/function miniSize\(\)/.test(main), 'main.js 缺少 miniSize()');
  assert.ok(/function applyMiniSize\(/.test(main), 'main.js 缺少 applyMiniSize()（滑块改大小要落到窗口上）');
  // 拖动、创建、看门狗、钳制都必须走 miniSize()，不能再出现字面量 300
  assert.ok(/dragTarget\(c, offset, miniSize\(\)/.test(main), '拖动没有用当前配置的尺寸');
  assert.ok(/const size = miniSize\(\)/.test(main), '创建窗口/看门狗没有用当前配置的尺寸');
  assert.ok(/resizeAroundCenter\(b, size, area\)/.test(main), '改尺寸没有以圆盘中心为基准');
  // 雷达窗口是 resizable:false；有些平台会忽略"不可缩放窗口"的 setBounds 尺寸，
  // 所以设尺寸前后要临时放开/收回一次（窗口期全在同步代码里，用户碰不到）
  assert.ok(/setResizable\(true\)/.test(main) && /setResizable\(false\)/.test(main),
    '改尺寸时要临时放开 resizable 再收回，否则可能改不动');
});

test('接线：主窗口视野同步也不能架空「定位后自动居中」开关', () => {
  // 主窗口每次定位都会 emitView -> syncViewport；雷达收到后如果无条件 centerOnPlayer，
  // 那个开关就被架空了（关了照样每次跳回玩家）。必须在 !miniAutoCenter 时提前返回。
  const js = read('renderer/minimap.js');
  const at = js.indexOf('api.onViewportSync(');
  assert.ok(at > 0, 'minimap.js 里没有接 onViewportSync');
  const block = js.slice(at, at + 700);
  const guard = block.indexOf('if (!miniAutoCenter)');
  const center = block.indexOf('centerOnPlayer(false)');
  assert.ok(guard > 0, 'onViewportSync 没看「定位后自动居中」');
  assert.ok(center > guard, 'centerOnPlayer 必须在开关判断之后（关着时不许走到）');
  assert.ok(/return;/.test(block.slice(guard, center)), '关着时必须提前 return，不能继续居中');
});
