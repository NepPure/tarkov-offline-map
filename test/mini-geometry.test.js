'use strict';

/**
 * 小地图悬浮窗拖动/定位的几何计算测试
 */
const test = require('node:test');
const assert = require('node:assert');

const { clampToWorkArea, dragTarget, defaultPos, clampMiniSize, resizeAroundCenter, MINI_SIZE_DEFAULT, MINI_SIZE_MIN, MINI_SIZE_MAX } = require('../src/mini-geometry');

const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const SIZE = 300;

test('默认位置在主显示器右上角', () => {
  const p = defaultPos(SIZE, WA, 24);
  assert.strictEqual(p.x, 1920 - SIZE - 24);
  assert.strictEqual(p.y, 24);
});

test('工作区内的位置原样返回', () => {
  assert.deepStrictEqual(clampToWorkArea(700, 400, SIZE, WA), { x: 700, y: 400 });
});

test('拖到屏幕外会被钳制，仍保留 80px 可见', () => {
  assert.deepStrictEqual(clampToWorkArea(-5000, -5000, SIZE, WA), { x: -SIZE + 80, y: WA.y });
  assert.deepStrictEqual(clampToWorkArea(99999, 99999, SIZE, WA), { x: 1920 - 80, y: 1040 - 80 });
});

test('负坐标显示器（左侧副屏）可用', () => {
  const wa = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.deepStrictEqual(clampToWorkArea(-1800, 100, SIZE, wa), { x: -1800, y: 100 });
});

test('拖动目标 = 光标 - 抓取偏移（光标不动则窗口不动）', () => {
  const offset = { x: 120, y: 60 };
  assert.deepStrictEqual(dragTarget({ x: 1000, y: 500 }, offset, SIZE, WA), { x: 880, y: 440 });
  // 光标移动多少，窗口就移动多少
  assert.deepStrictEqual(dragTarget({ x: 1048, y: 536 }, offset, SIZE, WA), { x: 928, y: 476 });
});

test('拖动时同样受工作区钳制（不会把窗口拖丢）', () => {
  const p = dragTarget({ x: -2000, y: -2000 }, { x: 150, y: 150 }, SIZE, WA);
  assert.strictEqual(p.x, -SIZE + 80);
  assert.strictEqual(p.y, 0);
});

// ---------------------------------------------------------------------------
// 雷达窗口大小（设置里那个滑块）
// ---------------------------------------------------------------------------
test('雷达窗口大小：老配置/乱写一律回默认 300，越界夹到 180~560', () => {
  assert.strictEqual(MINI_SIZE_DEFAULT, 300);
  assert.strictEqual(MINI_SIZE_MIN, 180);
  assert.strictEqual(MINI_SIZE_MAX, 560);
  assert.strictEqual(clampMiniSize(undefined), 300);
  assert.strictEqual(clampMiniSize(null), 300);
  assert.strictEqual(clampMiniSize(''), 300);
  assert.strictEqual(clampMiniSize('abc'), 300);
  assert.strictEqual(clampMiniSize(NaN), 300);
  assert.strictEqual(clampMiniSize(0), 180);
  assert.strictEqual(clampMiniSize(-50), 180);
  assert.strictEqual(clampMiniSize(9999), 560);
  assert.strictEqual(clampMiniSize(420), 420);
  assert.strictEqual(clampMiniSize(419.6), 420); // 四舍五入到整数像素
});

test('改尺寸以圆盘中心为基准（盯着的那块地图不动）', () => {
  // 300x300 在 (100,100) -> 中心 (250,250)；变成 400 -> (50,50) 起，中心仍是 (250,250)
  assert.deepStrictEqual(resizeAroundCenter({ x: 100, y: 100, width: 300, height: 300 }, 400, WA), { x: 50, y: 50 });
  // 变小同理
  assert.deepStrictEqual(resizeAroundCenter({ x: 100, y: 100, width: 300, height: 300 }, 200, WA), { x: 150, y: 150 });
});

test('放大到工作区外时会被钳制（仍然保留 80px 可见）', () => {
  const wa = { x: 0, y: 0, width: 1000, height: 800 };
  // 右下角的小雷达放大：右/下两边都要收回来
  const p = resizeAroundCenter({ x: 900, y: 700, width: 200, height: 200 }, 560, wa);
  assert.ok(p.x >= wa.x - 560 + 80 && p.x <= wa.x + wa.width - 80, `x=${p.x} 越界`);
  assert.ok(p.y >= wa.y && p.y <= wa.y + wa.height - 80, `y=${p.y} 越界`);
});

