'use strict';

/**
 * 小地图标记底盘形状：不同分组必须用不同形状（否则"全是一模一样的圆圈，没有辨识度"）
 * map-view.js 是 ESM，这里用动态 import 拿纯函数（不触碰 DOM）。
 */
const test = require('node:test');
const assert = require('node:assert');

let markerShape = null;
let shapeEl = null;

test('标记底盘形状按分组区分', async () => {
  ({ markerShape, shapeEl } = await import('../renderer/common/map-view.js'));
  assert.ok(markerShape && shapeEl, 'map-view.js 应导出 markerShape/shapeEl');

  assert.strictEqual(markerShape('extract_pmc'), 'shield');
  assert.strictEqual(markerShape('extract_scav'), 'shield');
  assert.strictEqual(markerShape('boss'), 'hexagon');
  assert.strictEqual(markerShape('btrStop'), 'hexagon');
  assert.strictEqual(markerShape('lock'), 'square');
  assert.strictEqual(markerShape('switch'), 'square');
  assert.strictEqual(markerShape('loot:safe'), 'square');
  assert.strictEqual(markerShape('transit'), 'diamond');
  assert.strictEqual(markerShape('weapon'), 'diamond');
  assert.strictEqual(markerShape('hazard'), 'triangle');
  assert.strictEqual(markerShape('season:pmc'), 'circle');
  assert.strictEqual(markerShape('spawn'), 'circle');

  // 关键分组必须落在不同的形状上（形状本身也是辨识度的一部分）
  const kinds = new Set([
    markerShape('extract_pmc'), markerShape('boss'), markerShape('lock'),
    markerShape('transit'), markerShape('hazard'), markerShape('season:pmc'),
  ]);
  assert.strictEqual(kinds.size, 6, '撤离点/Boss/锁/转移点/危险/赛季文件 形状必须互不相同');
});
