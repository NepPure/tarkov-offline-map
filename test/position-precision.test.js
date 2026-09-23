'use strict';

/**
 * 定位精度回归测试。
 *
 * 背景：有人反馈"坐标定位精度不高，是不是计算时没保留小数"。实测结论是**没有丢小数**：
 * 解析用 Number() 直取、投影/反投影都是浮点、渲染层只在小数显示和像素对齐时才 toFixed。
 * 这个测试把这条结论固化下来——以后谁在链路上加了 Math.round / toFixed / | 0，
 * 这里会直接红，而不是等用户反馈"定位偏了"。
 *
 * 精度的真正上限（不在代码里，写在这里备忘）：
 *  1. 位置只在"按截图键"时更新（默认自动截图 30s 一次 → 跑动中最多滞后约 165m）
 *  2. 底图与点位是社区手工测绘（同一撤离点在两家上游之间能差 10~70m）
 *  3. 游戏写进文件名的坐标只有 2 位小数（1cm，可忽略）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const { parseScreenshotFilename } = require('../src/parsers');
const { makeProjection, quaternionToEuler } = require('../src/projection');

const DUMP = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'maps-dump.json'), 'utf8'));
const LIGHTHOUSE = DUMP.maps.find((m) => m.id === '5704e4dad2720bb55b8b4567').detail;

test('截图文件名解析：小数位一位不少（不 toFixed、不截断）', () => {
  const name = '2026-09-07[23-05]_58.02, 1.75, 49.47_0.01518, 0.90924, -0.03197, 0.41476_15.47 (0).png';
  const p = parseScreenshotFilename(name);
  assert.strictEqual(p.x, 58.02);
  assert.strictEqual(p.y, 1.75);
  assert.strictEqual(p.z, 49.47);
  assert.deepStrictEqual(p.quaternion, [0.01518, 0.90924, -0.03197, 0.41476]);

  // 长小数也要原样保留（游戏现在是 2 位，将来给更多位也别被砍）
  const long = parseScreenshotFilename('2026-09-07[23-06]_-123.456789, 0.5, 987.654321_0.1, 0.2, 0.3, 0.4_9.9 (0).png');
  assert.strictEqual(long.x, -123.456789);
  assert.strictEqual(long.z, 987.654321);
});

test('投影往返误差是纯浮点级（<1e-9 米），没有量化', () => {
  const proj = makeProjection(LIGHTHOUSE);
  for (const [x, z] of [[-338.56, -782.37], [113.22, -989.23], [-364.4, -121.4], [0, 0], [-172.35, -6.39]]) {
    const p = proj.project(x, z);
    const back = proj.unproject(p.x, p.y);
    const err = Math.hypot(back.x - x, back.z - z);
    assert.ok(err < 1e-9, `(${x}, ${z}) 往返误差 ${err} 米，超出浮点范围（是不是加了取整？）`);
  }
});

test('相隔 1cm 的两个点在投影后仍然可区分（没有像素级量化）', () => {
  const proj = makeProjection(LIGHTHOUSE);
  const a = proj.project(-338.56, -782.37);
  const b = proj.project(-338.57, -782.38);
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(d > 0, '1cm 的差异被抹平了——说明某处做了取整');
  assert.ok(d < 0.01, `1cm 差异对应 ${d} 投影像素，比例异常`);
});

test('每张图的投影比例与底图分辨率自洽（屏幕上约 1 像素/米量级）', () => {
  for (const m of DUMP.maps) {
    const d = m.detail;
    if (!d || !d.transform || !d.bounds) continue;
    const proj = makeProjection(d);
    const o = proj.project(0, 0);
    const px1 = proj.project(1, 0);
    const pz1 = proj.project(0, 1);
    const perMeterX = Math.hypot(px1.x - o.x, px1.y - o.y);
    const perMeterZ = Math.hypot(pz1.x - o.x, pz1.y - o.y);
    assert.ok(perMeterX > 0.001 && perMeterX < 10, `${d.key}: x 方向每米 ${perMeterX} 像素，比例尺异常`);
    assert.ok(perMeterZ > 0.001 && perMeterZ < 10, `${d.key}: z 方向每米 ${perMeterZ} 像素，比例尺异常`);

    const [b1, b2] = d.bounds;
    const pts = [proj.project(b1[0], b1[1]), proj.project(b1[0], b2[1]), proj.project(b2[0], b1[1]), proj.project(b2[0], b2[1])];
    const wpx = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    const hpx = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
    assert.ok(wpx > 0 && hpx > 0, `${d.key}: 投影包围盒退化`);

    // 投影是"旋转 + 缩放"，对角线与旋转无关。
    // 均比缩放时对角线比例应精确等于每米像素；破冰船的 transform 是各向异性的
    // （scaleX=2 / scaleY=3.5），此时对角线比例应落在两个方向的比例之间。
    const diagRatio = Math.hypot(wpx, hpx) / Math.hypot(Math.abs(b1[0] - b2[0]) || 1, Math.abs(b1[1] - b2[1]) || 1);
    const lo = Math.min(perMeterX, perMeterZ);
    const hi = Math.max(perMeterX, perMeterZ);
    if (Math.abs(perMeterX - perMeterZ) < 1e-9) {
      assert.ok(Math.abs(diagRatio - perMeterX) < 1e-6, `${d.key}: 均比缩放下对角线比例 ${diagRatio} 与每米像素 ${perMeterX} 不一致`);
    } else {
      assert.ok(diagRatio >= lo - 1e-6 && diagRatio <= hi + 1e-6, `${d.key}: 各向异性缩放对角线比例 ${diagRatio} 越界 [${lo}, ${hi}]`);
    }
  }
});

test('四元数转朝向保留精度（不做整数化）', () => {
  const e = quaternionToEuler([0.01518, 0.90924, -0.03197, 0.41476]);
  assert.ok(Number.isFinite(e[0]) && e[0] > 130 && e[0] < 132, `yaw 应约 131°，实际 ${e[0]}`);
  assert.notStrictEqual(e[0], Math.round(e[0]), '朝向被整数化了（会看到箭头一跳一跳）');
});
