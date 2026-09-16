'use strict';

/**
 * 小地图悬浮窗拖动/定位的几何计算测试
 */
const test = require('node:test');
const assert = require('node:assert');

const { clampToWorkArea, dragTarget, defaultPos } = require('../src/mini-geometry');

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
