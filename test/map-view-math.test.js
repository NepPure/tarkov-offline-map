'use strict';

/**
 * 渲染层的投影换算：metersToScreen 必须返回"屏幕距离"而不是单轴分量。
 *
 * 回归背景：小地图"半径 N 米铺满圆盘"的换算最初写成只看 x/y 分量，
 * 而工厂这类 coordinateRotation=90°(或实验室 270°) 的地图，+x 的世界偏移
 * 只体现在屏幕 y 上，于是距离算成 0 → 缩放被钳到最大值 60，圆盘里只剩 1 个标记。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dump = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'maps-dump.json'), 'utf8'));

test('metersToScreen：所有地图都返回与 transform 一致的屏幕距离', async () => {
  const { makeProjection, metersToScreen } = await import('../renderer/common/map-view.js');
  for (const { detail } of dump.maps) {
    if (!detail || !detail.transform) continue;
    const proj = makeProjection(detail);
    const [b1, b2] = detail.bounds;
    const cx = (b1[0] + b2[0]) / 2;
    const cz = (b1[1] + b2[1]) / 2;
    const dist = metersToScreen(proj, cx, cz, 55);
    // 55 米对应的屏幕距离 = 55 * max(|n|, |i|)（两个方向取较大者，与坐标旋转无关）
    const expected = 55 * Math.max(Math.abs(detail.transform[0]), Math.abs(detail.transform[2]));
    assert.ok(dist > 1, `${detail.key} 屏幕距离异常：${dist}`);
    assert.ok(
      Math.abs(dist - expected) / expected < 1e-6,
      `${detail.key} 屏幕距离 ${dist} 应约等于 ${expected}`
    );
  }
});

test('metersToScreen：coordinateRotation=90° 的地图不能退化成 0', async () => {
  const { makeProjection, metersToScreen } = await import('../renderer/common/map-view.js');
  const factory = dump.maps.map((m) => m.detail).find((d) => d.key === 'factory');
  assert.strictEqual(factory.coordinateRotation, 90, '工厂应是 90° 旋转（本用例的前提）');
  const proj = makeProjection(factory);
  const p0 = proj.project(0, 0);
  const p1 = proj.project(55, 0);
  // 旋转 90° 时 +x 偏移在屏幕 x 上确实没有分量——正是旧实现踩的坑
  assert.ok(Math.abs(p1.x - p0.x) < 1e-9, '工厂 +x 偏移的屏幕 x 分量为 0');
  assert.ok(Math.abs(p1.y - p0.y) > 50, '但屏幕 y 分量很大');
  assert.ok(metersToScreen(proj, 0, 0, 55) > 50, '必须取屏幕距离，否则缩放失控');
});

test('小地图标准视野：55 米半径铺满 300px 圆盘', async () => {
  const { makeProjection, metersToScreen } = await import('../renderer/common/map-view.js');
  for (const key of ['factory', 'customs', 'lighthouse', 'shoreline', 'the-lab']) {
    const detail = dump.maps.map((m) => m.detail).find((d) => d.key === key);
    const proj = makeProjection(detail);
    const dist = metersToScreen(proj, 0, 0, 55);
    const scale = Math.min(60, Math.max(0.01, 150 / dist));
    // 55 米在该缩放下的屏幕像素 = 圆盘半径 150px
    assert.ok(Math.abs(dist * scale - 150) < 1e-6, `${key} 半径换算错误：${dist * scale}`);
    assert.ok(scale > 0.5 && scale < 60, `${key} 缩放 ${scale} 不应撞到钳位`);
  }
});
