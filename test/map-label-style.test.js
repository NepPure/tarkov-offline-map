'use strict';

/**
 * 地名文字样式：白字 + 深色外框，外框随字号变粗（配合 paint-order=stroke 保证平滑）
 */
const test = require('node:test');
const assert = require('node:assert');

let mapLabelFontSize = null;
let mapLabelStyle = null;

test('地名文字大小：随缩放/倍率变化并钳位', async () => {
  ({ mapLabelFontSize, mapLabelStyle } = await import('../renderer/common/map-view.js'));

  const base = mapLabelFontSize(1, 1, false);
  assert.ok(base >= 14, `默认字号应明显大于旧版(11)，实际 ${base}`);

  // "地名文字大小"设置成倍生效
  assert.ok(Math.abs(mapLabelFontSize(1, 2, false) - base * 2) < 1e-9);
  assert.ok(mapLabelFontSize(1, 2.5, false) > mapLabelFontSize(1, 1.5, false));
  // 上下限：整图视图也不能小到看不清，也不能大到糊满屏
  assert.ok(mapLabelFontSize(0.1, 0.1, false) >= 10);
  assert.ok(mapLabelFontSize(9, 9, false) <= 44);
  // 小地图有自己的量级（更小）
  assert.ok(mapLabelFontSize(1, 1, true) < base, '小地图地名应比主窗口小');
});

test('地名文字样式：内色为白、外框为深色且随字号变粗', async () => {
  ({ mapLabelStyle } = await import('../renderer/common/map-view.js'));
  const small = mapLabelStyle(12);
  const big = mapLabelStyle(30);
  assert.strictEqual(small.fill, '#ffffff');
  assert.strictEqual(big.fill, '#ffffff');
  assert.ok(/^#[0-9a-f]{6}$/i.test(small.stroke), '外框应是实色');
  assert.ok(big.strokeWidth > small.strokeWidth, '字号越大外框越粗');
  assert.ok(small.strokeWidth >= 2.4, '外框不能细到看不出对比');
});
