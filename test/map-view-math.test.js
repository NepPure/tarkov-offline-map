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

/**
 * 拖动平移（主窗口的地图拖动 与 雷达的 Ctrl 拖动 共用同一份换算）：
 * 光标往右拖 -> 地图跟着往右走 -> 视野中心往左移，位移量 = 屏幕位移 / 缩放。
 */
test('拖动平移：屏幕位移按缩放折算到地图像素，方向与"抓住地图"一致', async () => {
  const { panCenterAfterDrag } = await import('../renderer/common/map-view.js');
  const right = panCenterAfterDrag(1000, 2000, 2, 0, 100, 0);
  assert.strictEqual(right.cx, 950); // 往右拖 100px，scale=2 -> 中心左移 50
  assert.strictEqual(right.cy, 2000);
  const down = panCenterAfterDrag(1000, 2000, 2, 0, 0, 100);
  assert.strictEqual(down.cx, 1000);
  assert.strictEqual(down.cy, 1950);
  // 缩小到 scale=0.5 时，同样的屏幕位移对应更大的地图位移
  assert.strictEqual(panCenterAfterDrag(0, 0, 0.5, 0, 100, 0).cx, -200);
});

test('拖动平移：随朝向旋转时按逆变换走（90° 下横拖变纵移）', async () => {
  const { panCenterAfterDrag } = await import('../renderer/common/map-view.js');
  const rot90 = Math.PI / 2;
  const p = panCenterAfterDrag(0, 0, 1, rot90, 100, 0);
  assert.ok(Math.abs(p.cx) < 1e-9, `cx 应约为 0，实际 ${p.cx}`);
  assert.ok(Math.abs(p.cy - 100) < 1e-9, `cy 应为 100，实际 ${p.cy}`);
  // 与不旋转时（横拖改 cx）不同：90° 下横拖只改 cy，证明走的是逆变换而不是直接加减
  assert.notStrictEqual(Math.sign(panCenterAfterDrag(0, 0, 1, 0, 100, 0).cx), 0);
});

test('拖动平移：拖出去再拖回来回到原位（可逆、无累积漂移）', async () => {
  const { panCenterAfterDrag } = await import('../renderer/common/map-view.js');
  const scale = 3.7, rot = 0.9;
  const a = panCenterAfterDrag(500, -300, scale, rot, 137, -49);
  const b = panCenterAfterDrag(a.cx, a.cy, scale, rot, -137, 49);
  assert.ok(Math.abs(b.cx - 500) < 1e-9 && Math.abs(b.cy + 300) < 1e-9, `应回到起点，得到 ${b.cx},${b.cy}`);
});
